import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is required');
  process.exit(1);
}

const USE_ELEVENLABS = !!ELEVENLABS_API_KEY && !!ELEVENLABS_VOICE_ID;

console.log('🚀 Realtime WebSocket Server v18 starting...');
console.log('📍 Port:', PORT);
console.log('🌐 API Base URL:', API_BASE_URL);
console.log('🎤 Voice Provider:', USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI');
console.log('🎙️ Voice ID:', ELEVENLABS_VOICE_ID || 'N/A');

const activeSessions = new Map();

// ============================================================
// INTEREST DETECTION KEYWORDS (v18: Refined - removed overly generic words)
// Only trigger on clear, unambiguous interest signals
// ============================================================
const POSITIVE_INTEREST_KEYWORDS = [
  // Agendamento (strong signals)
  'agendar', 'marcar reunião', 'marcar uma reunião', 'agende', 'marque',
  'vamos marcar', 'vamos agendar',
  // Interesse explícito (strong signals)
  'tenho interesse', 'me interessa',
  'quero saber mais', 'saber mais', 'mais informações', 'mais informacoes',
  'me conte mais', 'como funciona',
  'quero conhecer', 'quero entender',
  // Compra/contratação (strong signals)
  'quero contratar', 'quero comprar', 'quanto custa',
  'qual o valor', 'qual o preço', 'qual o preco',
  'proposta', 'orçamento', 'orcamento',
  // Contato (strong signals)
  'meu email', 'meu telefone', 'meu whatsapp',
  'manda no whatsapp', 'envia por email',
  'pode ligar de volta', 'me liga depois',
  // Fechamento (strong signals)
  'fechado', 'vamos lá', 'vamos la', 'bora',
  'quero sim', 'com certeza quero',
];

// Negative signals (to avoid false positives)
const NEGATIVE_KEYWORDS = [
  'não tenho interesse', 'nao tenho interesse',
  'não quero', 'nao quero',
  'não preciso', 'nao preciso',
  'não obrigado', 'nao obrigado',
  'desculpa', 'sem interesse',
  'tô ocupado', 'to ocupado',
  'agora não', 'agora nao',
  'outro momento', 'não é o momento',
  'não me interessa', 'nao me interessa',
];

function detectInterest(text) {
  const lowerText = text.toLowerCase().trim();
  
  // Ignore very short responses (less than 3 words) - too ambiguous
  if (lowerText.split(/\s+/).length < 3) return { interested: false, signal: null };
  
  // Check negative first
  for (const neg of NEGATIVE_KEYWORDS) {
    if (lowerText.includes(neg)) return { interested: false, signal: null };
  }
  
  // Check positive signals
  for (const keyword of POSITIVE_INTEREST_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      return { interested: true, signal: keyword };
    }
  }
  
  return { interested: false, signal: null };
}

// ============================================================
// SEND TRANSCRIPTION TO ZENIX BACKEND
// ============================================================
async function sendTranscriptionToBackend(callSid, transcription, scriptId) {
  try {
    const formattedTranscription = transcription.map(t => 
      `[${t.role === 'assistant' ? 'ZENIX' : 'CLIENTE'}] ${t.text}`
    ).join('\n');
    
    const response = await fetch(`${API_BASE_URL}/api/twilio/save-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callSid,
        scriptId,
        transcription: formattedTranscription,
      }),
    });
    
    if (response.ok) {
      console.log(`[Transcription] ✅ Saved to backend for call ${callSid}`);
    } else {
      console.error(`[Transcription] ❌ Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Transcription] ❌ Error sending to backend:`, error.message);
  }
}

// ============================================================
// SEND INTEREST NOTIFICATION TO ZENIX BACKEND
// ============================================================
async function sendInterestNotification(callSid, contactPhone, signal, transcription, scriptId) {
  try {
    const formattedTranscription = transcription.map(t => 
      `[${t.role === 'assistant' ? 'ZENIX' : 'CLIENTE'}] ${t.text}`
    ).join('\n');
    
    const response = await fetch(`${API_BASE_URL}/api/twilio/client-interest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callSid,
        contactPhone,
        interestSignal: signal,
        transcription: formattedTranscription,
        scriptId,
        detectedAt: new Date().toISOString(),
      }),
    });
    
    if (response.ok) {
      console.log(`[Interest] ✅ Notification sent for call ${callSid} (signal: "${signal}")`);
    } else {
      console.error(`[Interest] ❌ Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Interest] ❌ Error sending notification:`, error.message);
  }
}

// ============================================================
// FETCH SCRIPT FROM ZENIX BACKEND
// ============================================================
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

// ============================================================
// ELEVENLABS TEXT-TO-SPEECH
// ============================================================
async function textToSpeechElevenLabs(text, twilioWs, streamSid) {
  try {
    const startTime = Date.now();
    console.log(`[ElevenLabs] 🎤 Converting: "${text.substring(0, 60)}..."`);
    
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/basic',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs] ❌ Error ${response.status}: ${errorText}`);
      return false;
    }

    const reader = response.body.getReader();
    let bytesSent = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const base64Audio = Buffer.from(value).toString('base64');
      bytesSent += value.length;
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64Audio } }));
      }
    }
    
    console.log(`[ElevenLabs] ✅ Sent ${bytesSent} bytes in ${Date.now() - startTime}ms`);
    return true;
  } catch (error) {
    console.error(`[ElevenLabs] ❌ Error:`, error.message);
    return false;
  }
}

// ============================================================
// CONNECT TO OPENAI REALTIME API
// ============================================================
function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve, reject) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    let script = null;
    if (scriptId) {
      script = await fetchScript(scriptId);
      if (script) console.log(`[OpenAI] ✅ Script loaded: ${script.name}`);
    }
    
    const useElevenLabs = USE_ELEVENLABS;
    console.log(`[OpenAI] Using ElevenLabs: ${useElevenLabs}`);
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
    });

    let greetingSent = false;
    let greetingResponseDone = false;
    let fullResponse = '';
    let isProcessing = false;
    let interestNotified = false;
    let transcriptionSaveTimer = null;
    let userMessageCount = 0; // v18: Track user messages to require minimum interaction before interest detection

    // Schedule periodic transcription save (every 15 seconds during active call)
    function scheduleTranscriptionSave() {
      if (transcriptionSaveTimer) clearTimeout(transcriptionSaveTimer);
      transcriptionSaveTimer = setTimeout(() => {
        if (sessionData.transcription.length > 0) {
          sendTranscriptionToBackend(callSid, sessionData.transcription, scriptId);
        }
        if (activeSessions.has(streamSid)) {
          scheduleTranscriptionSave();
        }
      }, 15000);
    }

    openaiWs.on('open', () => {
      console.log(`[OpenAI] ✅ Connected`);
      
      // v18: IMPROVED conversation rules - much more strict about following the script
      const conversationRules = `

=== REGRAS OBRIGATÓRIAS DE CONVERSAÇÃO TELEFÔNICA ===

ATENÇÃO: Esta é uma LIGAÇÃO TELEFÔNICA REAL para um cliente. Você DEVE seguir estas regras rigorosamente:

1. SIGA O SCRIPT FORNECIDO ACIMA com precisão. O script define exatamente o que você deve dizer e como deve conduzir a conversa.
2. Fale no MÁXIMO 2 frases curtas por vez. Frases longas são proibidas em ligações telefônicas.
3. Após CADA pergunta que você fizer, PARE COMPLETAMENTE e ESPERE a resposta do cliente. NÃO continue falando.
4. NUNCA faça duas perguntas na mesma fala. Uma pergunta por vez, sempre.
5. NUNCA repita informações que já disse. Se já se apresentou, NÃO se apresente novamente.
6. Seja NATURAL e CONVERSACIONAL. Fale como uma pessoa real, não como um robô.
7. ADAPTE suas respostas ao que o cliente diz. Se ele fizer uma pergunta, responda PRIMEIRO antes de continuar o script.
8. Se o cliente disser que não tem interesse, agradeça educadamente e encerre.
9. NÃO invente informações que não estão no script. Se não sabe algo, diga que vai verificar.
10. Use pausas naturais. Não fale rápido demais.

=== FIM DAS REGRAS ===

`;
      
      const userPrompt = script?.systemPrompt || 'Você é um assistente prestativo que fala português brasileiro.';
      
      // v18: Put script FIRST, then rules, so the AI prioritizes the script content
      const fullInstructions = `${userPrompt}\n\n${conversationRules}`;
      
      // Start with turn_detection DISABLED to prevent VAD from auto-generating responses
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: useElevenLabs ? ['text'] : ['text', 'audio'],
          instructions: fullInstructions,
          voice: 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: null, // DISABLED initially
          temperature: 0.6, // v18: Lower temperature for more consistent script following
          max_response_output_tokens: 120, // v18: Shorter responses to keep it conversational
        },
      }));
      
      scheduleTranscriptionSave();
      resolve({ openaiWs, useElevenLabs });
    });

    openaiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // Send greeting ONLY once when session is confirmed
        if (response.type === 'session.updated' && !greetingSent) {
          greetingSent = true;
          console.log(`[OpenAI] 🎬 Sending SINGLE greeting (VAD disabled)`);
          openaiWs.send(JSON.stringify({ 
            type: 'response.create', 
            response: { modalities: useElevenLabs ? ['text'] : ['text', 'audio'] } 
          }));
        }
        
        // After greeting response is DONE, re-enable VAD with LESS SENSITIVE settings
        if (response.type === 'response.done' && !greetingResponseDone) {
          greetingResponseDone = true;
          console.log(`[OpenAI] 🔄 Greeting complete, enabling VAD (v18: less sensitive)`);
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              turn_detection: { 
                type: 'server_vad', 
                threshold: 0.65,            // v18: Higher threshold (was 0.5) - less sensitive to noise
                prefix_padding_ms: 500,     // v18: More padding (was 300) - waits longer before detecting speech
                silence_duration_ms: 1200   // v18: Longer silence (was 700) - waits longer before responding
              },
            },
          }));
        }
        
        // Ignore second session.updated (VAD re-enable confirmation)
        if (response.type === 'session.updated' && greetingSent) {
          console.log(`[OpenAI] ℹ️ session.updated (VAD re-enabled), ignoring`);
        }
        
        if (response.type === 'response.audio.delta' && response.delta && !useElevenLabs) {
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.delta } }));
          }
        }
        
        if (response.type === 'response.text.delta' && response.delta && useElevenLabs) {
          fullResponse += response.delta;
        }
        
        if (response.type === 'response.text.done' && useElevenLabs) {
          const textToSpeak = fullResponse.trim();
          fullResponse = '';
          if (textToSpeak && !isProcessing) {
            isProcessing = true;
            console.log(`[OpenAI] 📝 Full response: "${textToSpeak}"`);
            sessionData.transcription.push({ role: 'assistant', text: textToSpeak, timestamp: new Date().toISOString() });
            await textToSpeechElevenLabs(textToSpeak, twilioWs, streamSid);
            isProcessing = false;
          }
        }

        // Also capture assistant audio transcription (non-ElevenLabs mode)
        if (response.type === 'response.audio_transcript.done' && !useElevenLabs) {
          const assistantText = response.transcript || '';
          if (assistantText.trim()) {
            console.log(`[ZENIX] 🤖 "${assistantText}"`);
            sessionData.transcription.push({ role: 'assistant', text: assistantText, timestamp: new Date().toISOString() });
          }
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          console.log(`[User] 🎤 Speaking...`);
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const userText = response.transcript || '';
          if (userText.trim()) {
            userMessageCount++;
            console.log(`[User] 💬 [${userMessageCount}] "${userText}"`);
            sessionData.transcription.push({ role: 'user', text: userText, timestamp: new Date().toISOString() });
            
            // v18: Only check interest after at least 2 user messages (avoid false positives from greetings)
            if (!interestNotified && userMessageCount >= 2) {
              const { interested, signal } = detectInterest(userText);
              if (interested) {
                interestNotified = true;
                console.log(`[Interest] 🔔 Positive signal detected: "${signal}" from "${userText}"`);
                sendInterestNotification(
                  callSid, 
                  sessionData.contactPhone || 'unknown', 
                  signal, 
                  sessionData.transcription,
                  scriptId
                );
              }
            }
          }
        }
        
        if (response.type === 'error') console.error(`[OpenAI] ❌ Error:`, response.error);
      } catch (error) {
        console.error(`[OpenAI] Parse error:`, error.message);
      }
    });

    openaiWs.on('error', (error) => { console.error(`[OpenAI] ❌ Error:`, error.message); reject(error); });
    openaiWs.on('close', (code) => {
      console.log(`[OpenAI] Connection closed (code: ${code})`);
      if (transcriptionSaveTimer) clearTimeout(transcriptionSaveTimer);
      if (sessionData.transcription.length > 0) {
        console.log(`[Transcription] 📝 Final save for call ${callSid} (${sessionData.transcription.length} messages)`);
        sendTranscriptionToBackend(callSid, sessionData.transcription, scriptId);
      }
    });
  });
}

// ============================================================
// HANDLE TWILIO WEBSOCKET CONNECTION
// ============================================================
function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const sessionData = { transcription: [], startTime: new Date(), contactPhone: null };
  console.log('[Twilio] 🎤 New connection');
  
  let streamSid = null, openaiWs = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        const callSid = data.start.callSid;
        const scriptId = data.start.customParameters?.scriptId || query.scriptId;
        // v18: Extract contact phone from custom parameters, query, or Twilio call data
        sessionData.contactPhone = data.start.customParameters?.contactPhone 
          || data.start.customParameters?.to 
          || query.contactPhone 
          || data.start.customParameters?.From  // Twilio provides caller info
          || null;
        console.log(`[Twilio] 🚀 Stream: ${streamSid}, Call: ${callSid}, Script: ${scriptId}, Phone: ${sessionData.contactPhone}`);
        const result = await connectToOpenAI(ws, streamSid, callSid, scriptId, sessionData);
        openaiWs = result.openaiWs;
        activeSessions.set(streamSid, { twilioWs: ws, openaiWs, streamSid, startTime: new Date() });
      }
      if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      }
      if (data.event === 'stop') {
        console.log(`[Twilio] 🛑 Stream stopped`);
        if (openaiWs) openaiWs.close();
        if (streamSid) activeSessions.delete(streamSid);
      }
    } catch (error) { console.error('[Twilio] Error:', error.message); }
  });

  ws.on('close', () => { console.log(`[Twilio] 👋 Disconnected`); if (openaiWs) openaiWs.close(); if (streamSid) activeSessions.delete(streamSid); });
}

// ============================================================
// HTTP SERVER + WEBSOCKET SERVER
// ============================================================
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      version: '18.0.0',
      voiceProvider: USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI',
      voiceId: ELEVENLABS_VOICE_ID || 'N/A',
      activeSessions: activeSessions.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v18\n');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  if (pathname === '/media-stream') handleTwilioConnection(ws, req);
  else ws.close();
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`✅ Server v18 running on port ${PORT}`);
  console.log(`🎤 Voice: ${USE_ELEVENLABS ? 'ElevenLabs' : 'OpenAI'}`);
  console.log(`🎙️ Voice ID: ${ELEVENLABS_VOICE_ID || 'N/A'}`);
  console.log(`🌐 API: ${API_BASE_URL}`);
  console.log('========================================');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
