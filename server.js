import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY ) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

console.log('🚀 Realtime WebSocket Server v3 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);

const activeSessions = new Map();

async function fetchScript(scriptId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/scripts/${scriptId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[Script] Failed to fetch script ${scriptId}:`, error.message);
    return null;
  }
}

async function saveTranscription(callSid, scriptId, transcription) {
  try {
    console.log(`[Transcription] Saving transcription for call ${callSid}...`);
    const response = await fetch(`${API_BASE_URL}/api/twilio/save-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid, scriptId, transcription }),
    });
    if (!response.ok) {
      console.error(`[Transcription] Failed to save: HTTP ${response.status}`);
    } else {
      console.log(`[Transcription] ✅ Saved successfully for call ${callSid}`);
    }
  } catch (error) {
    console.error(`[Transcription] Error saving:`, error.message);
  }
}

function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) {
        console.log(`[OpenAI] Script loaded: ${script.name}`);
        console.log(`[OpenAI] Voice: ${script.voiceId || 'alloy'}`);
      } else {
        console.warn(`[OpenAI] Script ${scriptId} not found, using defaults`);
      }
    }
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected for stream ${streamSid}`);
      
      const systemInstructions = script?.systemPrompt || 
        'Você é um assistente prestativo que fala português brasileiro de forma natural e amigável.';
      
      const voiceInstructions = script?.voiceInstructions || '';
      
      const fullInstructions = voiceInstructions 
        ? `${systemInstructions}\n\nInstruções de voz: ${voiceInstructions}`
        : systemInstructions;
      
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: fullInstructions,
          voice: script?.voiceId || 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.3,
            prefix_padding_ms: 200,
            silence_duration_ms: 400,
          },
          temperature: 0.7,
        },
      };

      openaiWs.send(JSON.stringify(sessionConfig));
      console.log(`[OpenAI] Session configured with script: ${script?.name || 'default'}`);
      
      setTimeout(() => {
        const responseCreate = {
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
            instructions: 'Inicie a conversa seguindo EXATAMENTE as instruções do seu papel. Seja breve e natural.',
          },
        };
        openaiWs.send(JSON.stringify(responseCreate));
        console.log(`[OpenAI] Initial greeting requested`);
      }, 500);
      
      resolve(openaiWs);
    });

    openaiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        if (response.type === 'response.audio.delta' && response.delta) {
          const twilioMessage = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify(twilioMessage));
          }
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          console.log(`[OpenAI] 🎤 User started speaking - interrupting AI`);
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'clear',
              streamSid: streamSid,
            }));
          }
        }
        
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userText = response.transcript || '';
          if (userText.trim()) {
            sessionData.transcription.push({
              role: 'user',
              text: userText,
              timestamp: new Date().toISOString(),
            });
            console.log(`[Transcription] User: ${userText.substring(0, 80)}...`);
          }
        }
        
        if (response.type === 'response.audio_transcript.done') {
          const aiText = response.transcript || '';
          if (aiText.trim()) {
            sessionData.transcription.push({
              role: 'assistant',
              text: aiText,
              timestamp: new Date().toISOString(),
            });
            console.log(`[Transcription] AI: ${aiText.substring(0, 80)}...`);
          }
        }
        
        if (response.type === 'error') {
          console.error(`[OpenAI] Error:`, response.error);
        }
      } catch (error) {
        console.error(`[OpenAI] Error parsing message:`, error.message);
      }
    });

    openaiWs.on('error', (error) => {
      console.error(`[OpenAI] WebSocket error:`, error.message);
      reject(error);
    });

    openaiWs.on('close', async () => {
      console.log(`[OpenAI] Connection closed for stream ${streamSid}`);
      
      if (sessionData.transcription.length > 0 && callSid) {
        const transcriptionText = sessionData.transcription
          .map(t => `[${t.role.toUpperCase()}]: ${t.text}`)
          .join('\n');
        await saveTranscription(callSid, scriptId, transcriptionText);
      }
    });
  });
}

function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const callSid = query.callSid;
  const scriptId = query.scriptId;
  
  const sessionData = {
    transcription: [],
    startTime: new Date(),
  };
  
  console.log('========================================');
  console.log('[Twilio] 🎤 New connection');
  console.log('[Twilio] Call SID:', callSid || 'N/A');
  console.log('[Twilio] Script ID:', scriptId || 'N/A');
  console.log('========================================');
  
  let streamSid = null;
  let openaiWs = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'connected':
          console.log('[Twilio] 📞 Connected event received');
          break;

        case 'start':
          streamSid = data.start.streamSid;
          const actualCallSid = data.start.callSid;
          const actualScriptId = data.start.customParameters?.scriptId || scriptId;
          
          console.log(`[Twilio] 🚀 Stream started`);
          console.log(`[Twilio] Stream SID: ${streamSid}`);
          console.log(`[Twilio] Call SID: ${actualCallSid}`);
          console.log(`[Twilio] Script ID: ${actualScriptId || 'none'}`);
          
          try {
            openaiWs = await connectToOpenAI(ws, streamSid, actualCallSid, actualScriptId, sessionData);
            
            activeSessions.set(streamSid, {
              twilioWs: ws,
              openaiWs,
              streamSid,
              callSid: actualCallSid,
              scriptId: actualScriptId,
              sessionData,
            });
          } catch (error) {
            console.error('[Twilio] ❌ Failed to connect to OpenAI:', error.message);
          }
          break;

        case 'media':
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioPayload = data.media.payload;
            
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: audioPayload,
            }));
          }
          break;

        case 'stop':
          console.log('[Twilio] 🛑 Stream stopped');
          if (openaiWs) openaiWs.close();
          if (streamSid) activeSessions.delete(streamSid);
          break;
      }
    } catch (error) {
      console.error('[Twilio] Error handling message:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('[Twilio] 🔌 Connection closed');
    if (openaiWs) openaiWs.close();
    if (streamSid) activeSessions.delete(streamSid);
  });

  ws.on('error', (error) => {
    console.error('[Twilio] WebSocket error:', error.message);
  });
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      version: '3.0.0',
      activeSessions: activeSessions.size,
      uptime: process.uptime(),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v3\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  
  if (pathname === '/media-stream') {
    handleTwilioConnection(ws, req);
  } else {
    console.log(`[Server] ❌ Unknown path: ${pathname}`);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 WebSocket endpoint: ws://localhost:${PORT}/media-stream`);
  console.log(`💚 Health check: http://localhost:${PORT}/health` );
  console.log('========================================');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
