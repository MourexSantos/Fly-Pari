import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { INITIAL_FORUM_POSTS, INITIAL_ALERTS, GUARAPARI_BIRDS } from './src/birdsData';
import { ForumPost, SightAlert, BirdObservation } from './src/types';

// Load env variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = 3000;

// Set high limit for base64 photo uploads
app.use(express.json({ limit: '15mb' }));

// In-memory Shared Server Databases (persists during container lifetime)
let forumPosts: ForumPost[] = [...INITIAL_FORUM_POSTS];
let sightAlerts: SightAlert[] = [...INITIAL_ALERTS];
let sharedObservations: BirdObservation[] = []; // Collective sightings shown on map

// Setup Gemini API client
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
} else {
  console.warn('⚠️ GEMINI_API_KEY is not defined in environment variables. Bird identification features will fallback to simulation.');
}

// ==========================================
// API ROUTES
// ==========================================

// Get health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), hasGemini: !!ai });
});

// GET species list
app.get('/api/birds/species', (req, res) => {
  res.json(GUARAPARI_BIRDS);
});

// POST to identify bird from photo using Gemini
app.post('/api/birds/identify', async (req, res) => {
  const { image } = req.body; // base64 representation of the image

  if (!image) {
    return res.status(400).json({ error: 'Nenhuma imagem foi fornecida.' });
  }

  // Extract base64 clean data (strip data:image/png;base64, etc. if present)
  let cleanBase64 = image;
  let mimeType = 'image/jpeg';

  const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
  if (matches && matches.length === 3) {
    mimeType = matches[1];
    cleanBase64 = matches[2];
  }

  // Fallback to simulation if Gemini is not configured
  if (!ai) {
    console.log('Using simulated bird identification (API key not present)');
    // Pick a random species from our Guarapari list for simulation
    const randomIndex = Math.floor(Math.random() * GUARAPARI_BIRDS.length);
    const mockBird = GUARAPARI_BIRDS[randomIndex];
    
    return setTimeout(() => {
      res.json({
        name: mockBird.name,
        scientificName: mockBird.scientificName,
        englishName: mockBird.englishName,
        characteristics: mockBird.characteristics,
        habitat: mockBird.habitat,
        voiceText: mockBird.voiceText,
        confidence: 94,
        isABird: true,
        explanation: `[SIMULADO - Cadastre sua Chave API do Gemini em Configurações para identificação por IA real] Esta é uma simulação de identificação do ${mockBird.name}, espécie abundante em Guarapari.`
      });
    }, 1500);
  }

  try {
    const promptString = `Identify this bird. It is photographed in Guarapari, Espírito Santo, Brazil. 
Analyze the image. First verify if the image contains a bird. If it is NOT a bird, flag isABird = false.
If it is a bird, output the exact common name in Portuguese (Brazil) as "name", the scientific name as "scientificName", and the english common name as "englishName".
Provide descriptions for characteristics, habitat, and voice text, specifically focusing on the Atlantic Forest / Restinga ecosystems of Guarapari and Espírito Santo (e.g. Parque Estadual Paulo César Vinha, Lagoa de Caraís).
Provide your identification in the requested JSON structure.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: cleanBase64,
          },
        },
        promptString
      ],
      config: {
        systemInstruction: 'You are an elite Brazilian ornithologist specializing in birds of Espírito Santo, Brazil, especially coastal areas, restinga (Paulo César Vinha), and Atlantic Forest. Identify species with accuracy and provide descriptions strictly in Portuguese (Brazil).',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: 'Common name of the bird in Portuguese (Brazil).' },
            scientificName: { type: Type.STRING, description: 'Scientific name of the species.' },
            englishName: { type: Type.STRING, description: 'English common name.' },
            characteristics: { type: Type.STRING, description: 'Bullet list or descriptive characteristics of this species.' },
            habitat: { type: Type.STRING, description: 'Habitat where it is typically found in Guarapari/ES.' },
            voiceText: { type: Type.STRING, description: 'Description of the song, chirps, or warning calls of the species.' },
            confidence: { type: Type.INTEGER, description: 'Confidence level percentage (1-100).' },
            isABird: { type: Type.BOOLEAN, description: 'True if the image contains a bird, false if it is a landscape, person, object or other animal.' },
            explanation: { type: Type.STRING, description: 'A friendly tip on where in Guarapari this species is typically spotted, and conservation suggestions.' }
          },
          required: ['name', 'scientificName', 'englishName', 'characteristics', 'habitat', 'voiceText', 'confidence', 'isABird']
        }
      }
    });

    const resultText = response.text;
    if (!resultText) {
      throw new Error('Retorno vazio do Gemini API.');
    }

    const data = JSON.parse(resultText);
    res.json(data);
  } catch (error: any) {
    console.error('Error on Gemini Identification API:', error);
    res.status(500).json({ error: 'Falha ao identificar ave através do Gemini: ' + (error.message || error) });
  }
});

// GET forum posts
app.get('/api/forum', (req, res) => {
  res.json(forumPosts);
});

// POST a new forum post
app.post('/api/forum', (req, res) => {
  const { author, content, speciesMentioned } = req.body;
  if (!author || !content) {
    return res.status(400).json({ error: 'Autor e conteúdo são necessários.' });
  }

  const newPost: ForumPost = {
    id: `post_${Date.now()}`,
    author,
    content,
    timestamp: new Date().toISOString(),
    speciesMentioned,
    replies: []
  };

  forumPosts.unshift(newPost);
  res.status(201).json(newPost);
});

// POST reply to a forum post
app.post('/api/forum/:postId/reply', (req, res) => {
  const { postId } = req.params;
  const { author, content } = req.body;

  if (!author || !content) {
    return res.status(400).json({ error: 'Autor e conteúdo são necessários para responder.' });
  }

  const postIndex = forumPosts.findIndex(p => p.id === postId);
  if (postIndex === -1) {
    return res.status(404).json({ error: 'Post do fórum não encontrado.' });
  }

  const newReply = {
    id: `reply_${Date.now()}`,
    author,
    content,
    timestamp: new Date().toISOString()
  };

  forumPosts[postIndex].replies.push(newReply);
  res.status(201).json(forumPosts[postIndex]);
});

// GET sight alerts
app.get('/api/alerts', (req, res) => {
  res.json(sightAlerts);
});

// POST a new sight alert (triggers "push notification" to other users)
app.post('/api/alerts', (req, res) => {
  const { species, locationName, observer, coords } = req.body;
  if (!species || !locationName || !observer) {
    return res.status(400).json({ error: 'Espécie, local e observador são obrigatórios.' });
  }

  const newAlert: SightAlert = {
    id: `alert_${Date.now()}`,
    species,
    locationName,
    timestamp: new Date().toISOString(),
    observer,
    coords: coords || [-20.668, -40.500] // default to central Guarapari
  };

  sightAlerts.unshift(newAlert);
  res.status(201).json(newAlert);
});

// GET shared occurrences/observations map
app.get('/api/shared-observations', (req, res) => {
  res.json(sharedObservations);
});

// POST sync observations from offline clients
app.post('/api/sync', (req, res) => {
  const { observations } = req.body; // Array of BirdObservation

  if (!observations || !Array.isArray(observations)) {
    return res.status(400).json({ error: 'A lista de observações deve ser um Array.' });
  }

  let count = 0;
  observations.forEach((obs: BirdObservation) => {
    // Avoid duplicates by checking existing observation ids
    const exists = sharedObservations.some(item => item.id === obs.id);
    if (!exists) {
      const syncedObs = { ...obs, synced: true };
      sharedObservations.push(syncedObs);
      count++;

      // Automatically trigger a shared sighting alert on server if it's not ancient
      const isRecent = (Date.now() - new Date(obs.date).getTime()) < 3600 * 1000 * 24; // within 24h
      if (isRecent) {
        const alertExists = sightAlerts.some(a => a.species === obs.species && a.observer === obs.observer);
        if (!alertExists) {
          sightAlerts.unshift({
            id: `alert_sync_${obs.id}`,
            species: obs.species,
            locationName: obs.locationName,
            timestamp: new Date().toISOString(),
            observer: obs.observer || 'Expedicionário',
            coords: obs.coords
          });
        }
      }
    }
  });

  res.json({ success: true, syncedCount: count, totalShared: sharedObservations.length });
});

// Clear all API cache/reset in-memory database (for testing)
app.post('/api/reset', (req, res) => {
  forumPosts = [...INITIAL_FORUM_POSTS];
  sightAlerts = [...INITIAL_ALERTS];
  sharedObservations = [];
  res.json({ success: true, message: 'Dados redefinidos para os valores padrões.' });
});

// ==========================================
// SERVING FRONTEND & VITE MIDDLEWARE
// ==========================================

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    // In development, hook Vite's dev server middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve the compiled assets inside 'dist'
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [Aves de Guarapari App] Server running at http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start full-stack server:', err);
});
