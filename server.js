import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_BASE_URL = process.env.API_BASE_URL || 'https://zenix.group';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

console.log('Realtime WebSocket Server v23.1 starting...');
console.log('Port:', PORT);
console.log('API Base URL:', API_BASE_URL);

const activeSessions = new Map();

// ============================================================
// INTEREST DETECTION KEYWORDS
// ============================================================
const POSITIVE_INTEREST_KEYWORDS = [
  'agendar', 'marcar reunião', 'marcar uma reunião', 'agende', 'marque',
  'vamos marcar', 'vamos agendar',
  'tenho interesse', 'me interessa',
  'quero saber mais', 'saber mais', 'mais informações', 'mais informacoes',
  'me conte mais', 'como funciona',
  'quero conhecer', 'quero entender',
  'quero contratar', 'quero comprar', 'quanto custa',
  'qual o valor', 'qual o preço', 'qual o preco',
  'proposta', 'orçamento', 'orcamento',
  'meu email', 'meu telefone', 'meu whatsapp',
  'manda no whatsapp', 'envia por email',
  'pode ligar de volta', 'me liga depois',
  'fechado', 'vamos lá', 'vamos la', 'bora',
  'quero sim', 'com certeza quero',
];

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
  if (lowerText.split(/\s+/).length < 3) return { interested: false, signal: null };
  for (const neg of NEGATIVE_KEYWORDS) {
    if (lowerText.includes(neg)) return { interested: false, signal: null };
  }
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
      body: JSON.stringify({ callSid, scriptId, transcription: formattedTranscription }),
    });
    
    if (response.ok) {
      console.log(`[Transcription] Saved for call ${callSid}`);
    } else {
      console.error(`[Transcription] Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Transcription] Error:`, error.message);
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
        callSid, contactPhone, interestSignal: signal,
        transcription: formattedTranscription, scriptId,
        detectedAt: new Date().toISOString(),
      }),
    });
    
    if (response.ok) {
      console.log(`[Interest] Notification sent for call ${callSid} (signal: "${signal}")`);
    } else {
      console.error(`[Interest] Backend returned ${response.status}`);
    }
  } catch (error) {
    console.error(`[Interest] Error:`, error.message);
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
// CONNECT TO OPENAI REALTIME API
// v23: Called ONLY after Twilio start event (like v21 did)
// Returns a promise that resolves with the OpenAI WebSocket
// ============================================================
function connectToOpenAI(twilioWs, streamSid, callSid, scriptId, sessionData) {
  return new Promise(async (resolve) => {
    console.log(`[OpenAI] Connecting for stream ${streamSid}...`);
    
    // Fetch script
    let scriptData = null;
    if (scriptId) {
      scriptData = await fetchScript(scriptId);
      if (scriptData) console.log(`[OpenAI] Script loaded: ${scriptData.name}`);
    }
    
    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    
    let sessionConfigured = false;
    let greetingSent = false;
    let vadEnabled = false;
    let audioChunksSent = 0;
    let interestNotified = false;
    let userMessageCount = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let latestMediaTimestamp = 0;
    
    // Expose latestMediaTimestamp setter for Twilio media events
    openaiWs._setMediaTimestamp = (ts) => { latestMediaTimestamp = ts; };
    
    // Build instructions
    const conversationRules = `

=== ESTILO DE COMUNICAÇÃO ===

Você é uma jovem brasileira simpática, carismática e envolvente. Sua personalidade é alegre, confiante e cativante. Você tem um jeitinho brasileiro charmoso e acolhedor.

COMO VOCÊ FALA:
- Fale com ENERGIA e CHARME. Sua voz transmite simpatia e confiança.
- Use expressões naturais e descontraídas: "ai que legal!", "olha só que bacana!", "poxa, entendo total", "nossa, que máximo!", "com certeza!", "adorei!", "que demais!"
- Tenha um tom JOVEM e ENVOLVENTE, como uma amiga que está animada para te contar algo incrível.
- Chame a pessoa pelo nome quando souber. Isso cria intimidade.
- Faça comentários que mostrem interesse genuíno: "Sério? Que interessante!", "Adorei saber disso!", "Nossa, que legal o que você faz!"
- Use um tom LEVE e DESCONTRAÍDO, como se estivesse num café com um amigo. Nada de formalidade.
- Seja CALOROSA e faça a pessoa se sentir especial e importante.

RITMO DA CONVERSA:
- Responda de forma NATURAL e FLUIDA. Seja espontânea.
- Use no máximo 3 frases por resposta. Mas faça cada frase ser envolvente.
- Após fazer uma pergunta, PARE e espere a resposta. Não faça duas perguntas seguidas.
- Se o cliente responder algo curto ("sim", "não", "tá"), reaja com entusiasmo antes de continuar: "Ótimo!", "Perfeito!", "Que bom!"
- Quando o cliente fizer uma pergunta, mostre empolgação ao responder.

O QUE NÃO FAZER:
- NÃO seja robótica ou mecânica. Você é uma PESSOA jovem e carismática.
- NÃO repita informações que já disse.
- NÃO invente dados que não estão no script.
- NÃO seja monótona. Varie o tom e a energia.
- NÃO use linguagem corporativa ou formal demais.

OBJETIVO: Criar uma conversa tão natural e agradável que o cliente queira continuar falando com você. Gere CONEXÃO, SIMPATIA e INTERESSE.

=== FIM DO ESTILO ===

`;
    
    const userPrompt = scriptData?.systemPrompt || 'Você é uma assistente prestativa e simpática que fala português brasileiro com naturalidade.';
    const fullInstructions = `${userPrompt}\n\n${conversationRules}`;
    
    // Send mark to Twilio for interruption tracking
    function sendMark() {
      if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' },
        }));
        markQueue.push('responsePart');
      }
    }
    
    // Handle user interruption
    function handleSpeechStarted() {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        
        if (lastAssistantItem && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          }));
        }
        
        // Clear Twilio audio buffer
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    }
    
    // Expose mark handler for Twilio mark events
    openaiWs._handleMark = () => { if (markQueue.length > 0) markQueue.shift(); };
    openaiWs._handleSpeechStarted = handleSpeechStarted;
    
    openaiWs.on('open', () => {
      console.log(`[OpenAI] Connected for stream ${streamSid}`);
      
      // Configure session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: fullInstructions,
          voice: 'shimmer',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: null, // Disabled initially, enabled after greeting
          temperature: 0.75,
          max_response_output_tokens: 200,
        },
      }));
      
      resolve({ openaiWs });
    });
    
    openaiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // SESSION UPDATED
        if (response.type === 'session.updated') {
          if (!sessionConfigured) {
            sessionConfigured = true;
            console.log('[OpenAI] Session configured');
            
            // Send greeting
            if (!greetingSent) {
              greetingSent = true;
              console.log('[OpenAI] Requesting greeting');
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: { modalities: ['text', 'audio'] },
              }));
            }
          } else if (!vadEnabled) {
            vadEnabled = true;
            console.log('[OpenAI] VAD enabled');
          }
          return;
        }
        
        // AUDIO DELTA - Forward to Twilio
        if ((response.type === 'response.audio.delta' || response.type === 'response.output_audio.delta') && response.delta) {
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: response.delta },
            }));
            audioChunksSent++;
            
            if (!responseStartTimestampTwilio) {
              responseStartTimestampTwilio = latestMediaTimestamp;
            }
            if (response.item_id) {
              lastAssistantItem = response.item_id;
            }
            sendMark();
            
            if (audioChunksSent === 1) {
              console.log(`[Audio] First chunk sent to Twilio`);
            }
          } else {
            console.log(`[Audio] WARNING: Twilio WS not open (state: ${twilioWs.readyState})`);
          }
        }
        
        // AUDIO TRANSCRIPT
        if (response.type === 'response.audio_transcript.done' || response.type === 'response.output_audio_transcript.done') {
          const text = response.transcript || '';
          if (text.trim()) {
            console.log(`[Assistant] "${text}"`);
            sessionData.transcription.push({ role: 'assistant', text, timestamp: new Date().toISOString() });
          }
        }
        
        // RESPONSE DONE - Enable VAD after greeting
        if (response.type === 'response.done') {
          console.log(`[OpenAI] Response done (chunks sent: ${audioChunksSent})`);
          if (!vadEnabled) {
            console.log('[OpenAI] Enabling VAD (1.5s delay)');
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: 'session.update',
                  session: {
                    turn_detection: {
                      type: 'server_vad',
                      threshold: 0.55,
                      prefix_padding_ms: 400,
                      silence_duration_ms: 900,
                    },
                  },
                }));
              }
            }, 1500);
          }
        }
        
        // USER SPEECH STARTED
        if (response.type === 'input_audio_buffer.speech_started') {
          console.log('[User] Speaking...');
          handleSpeechStarted();
        }
        
        // USER TRANSCRIPTION
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const text = response.transcript || '';
          if (text.trim()) {
            userMessageCount++;
            console.log(`[User] [${userMessageCount}]: "${text}"`);
            sessionData.transcription.push({ role: 'user', text, timestamp: new Date().toISOString() });
            
            if (!interestNotified && userMessageCount >= 2) {
              const { interested, signal } = detectInterest(text);
              if (interested) {
                interestNotified = true;
                console.log(`[Interest] Positive signal: "${signal}"`);
                sendInterestNotification(callSid, sessionData.contactPhone || 'unknown', signal, sessionData.transcription, scriptId);
              }
            }
          }
        }
        
        // ERROR
        if (response.type === 'error') {
          console.error(`[OpenAI] Error:`, JSON.stringify(response.error));
        }
      } catch (error) {
        console.error('[OpenAI] Parse error:', error.message);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error('[OpenAI] WebSocket error:', error.message);
      resolve({ openaiWs: null });
    });
    
    openaiWs.on('close', (code) => {
      console.log(`[OpenAI] Closed (code: ${code})`);
      if (sessionData.transcription.length > 0) {
        sendTranscriptionToBackend(callSid, sessionData.transcription, scriptId);
      }
    });
  });
}

// ============================================================
// HANDLE TWILIO WEBSOCKET CONNECTION
// v23: Connect to OpenAI ONLY on start event (like v21)
// ============================================================
function handleTwilioConnection(ws, req) {
  const { query } = parse(req.url, true);
  const sessionData = { transcription: [], startTime: new Date(), contactPhone: null };
  console.log('[Twilio] New WebSocket connection');
  
  let streamSid = null;
  let openaiWs = null;
  let callSid = null;
  let scriptId = null;
  let transcriptionSaveTimer = null;
  
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
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;
        scriptId = data.start.customParameters?.scriptId || query.scriptId;
        sessionData.contactPhone = data.start.customParameters?.contactPhone 
          || data.start.customParameters?.to 
          || query.contactPhone 
          || data.start.customParameters?.From
          || null;
        
        console.log(`[Twilio] Stream: ${streamSid}, Call: ${callSid}, Script: ${scriptId}, Phone: ${sessionData.contactPhone}`);
        
        // v23: Connect to OpenAI NOW (after we have streamSid)
        const result = await connectToOpenAI(ws, streamSid, callSid, scriptId, sessionData);
        openaiWs = result.openaiWs;
        
        if (openaiWs) {
          activeSessions.set(streamSid, { twilioWs: ws, openaiWs, streamSid, startTime: new Date() });
          scheduleTranscriptionSave();
        } else {
          console.error('[Twilio] Failed to connect to OpenAI');
        }
      }
      
      if (data.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
        // Update media timestamp for interruption handling
        if (openaiWs._setMediaTimestamp) {
          openaiWs._setMediaTimestamp(parseInt(data.media.timestamp) || 0);
        }
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: data.media.payload,
        }));
      }
      
      if (data.event === 'mark' && openaiWs?._handleMark) {
        openaiWs._handleMark();
      }
      
      if (data.event === 'stop') {
        console.log('[Twilio] Stream stopped');
        if (openaiWs) openaiWs.close();
        if (streamSid) activeSessions.delete(streamSid);
      }
    } catch (error) {
      console.error('[Twilio] Error:', error.message);
    }
  });
  
  ws.on('close', () => {
    console.log('[Twilio] Disconnected');
    if (openaiWs) openaiWs.close();
    if (streamSid) activeSessions.delete(streamSid);
    if (transcriptionSaveTimer) clearTimeout(transcriptionSaveTimer);
  });
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
      version: '23.1.0',
      voiceProvider: 'OpenAI Native',
      voiceId: 'shimmer',
      activeSessions: activeSessions.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Realtime WebSocket Server v23.1\n');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const { pathname } = parse(req.url);
  if (pathname === '/media-stream') {
    handleTwilioConnection(ws, req);
  } else {
    console.log('[WS] Unknown path:', pathname);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log(`Server v23.1 running on port ${PORT}`);
  console.log(`Voice: OpenAI Native (shimmer)`);
  console.log(`API: ${API_BASE_URL}`);
  console.log('========================================');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));
