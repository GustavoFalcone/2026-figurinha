import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const isVercel = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT) || 3100;
const publicDir = path.join(__dirname, '..', 'public');
const uploadDir = path.join(publicDir, 'uploads');
const outputDir = path.join(publicDir, 'output');
const runtimeDir = isVercel ? path.join('/tmp', 'figurinha-copa') : outputDir;
const mockupPath = path.join(publicDir, 'raphinha.png');
const regularFontPath = path.join(publicDir, 'fonts', 'LiberationSans-Regular.ttf');
const boldFontPath = path.join(publicDir, 'fonts', 'LiberationSans-Bold.ttf');
const jobs = new Map();
const isProduction = process.env.NODE_ENV === 'production';
// Timeout do client OpenAI: 290s (logo abaixo do maxDuration:300 do Vercel).
// gpt-image-2 em 1024x1536 quality=medium pode levar 60-180s em horarios de
// pico. Antes estavamos com 90s e dando 504 Gateway Timeout em producao.
const generationTimeoutMs = Number(process.env.OPENAI_GENERATION_TIMEOUT_MS) || 290000;

// ============================================================================
// RING BUFFER DE LOGS (visivel via GET /api/logs/tail no proprio site)
// ============================================================================
// Captura os ultimos 500 logs em memoria para voce poder ver no proprio site
// sem precisar abrir o dashboard do Vercel. Acesse /api/logs/tail.
const LOG_RING_MAX = 500;
const logRing = [];
function pushLog(level, args) {
  try {
    const line = args.map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    logRing.push({ t: Date.now(), level, line });
    if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
  } catch { /* never break the logger */ }
}
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log = (...a) => { pushLog('log', a); _origLog(...a); };
console.warn = (...a) => { pushLog('warn', a); _origWarn(...a); };
console.error = (...a) => { pushLog('error', a); _origError(...a); };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Envie uma imagem valida.'));
      return;
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

await Promise.all([
  fsp.mkdir(runtimeDir, { recursive: true }),
  fsp.mkdir(uploadDir, { recursive: true }).catch(() => undefined),
  fsp.mkdir(outputDir, { recursive: true }).catch(() => undefined)
]);

const requiredFields = ['nome', 'email', 'dia', 'mes', 'ano', 'clube', 'peso', 'altura'];
const months = {
  Janeiro: '01', Fevereiro: '02', Março: '03', Abril: '04',
  Maio: '05', Junho: '06', Julho: '07', Agosto: '08',
  Setembro: '09', Outubro: '10', Novembro: '11', Dezembro: '12'
};

// Middleware: loga toda requisicao com IP, UA, tempo de resposta.
app.use((req, res, next) => {
  const reqStart = Date.now();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  res.on('finish', () => {
    // Nao polui o log com assets estaticos
    if (/^\/(_next|fonts|.*\.(png|jpg|jpeg|webp|svg|ico|css|js|woff2?|map))/.test(req.path)) return;
    console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - reqStart}ms) ip=${ip} ua="${ua.slice(0, 80)}"`);
  });
  next();
});

// Endpoint de debug: retorna os ultimos 500 logs como JSON ou texto.
// Uso: https://2026-figurinha.vercel.app/api/logs/tail
//      https://2026-figurinha.vercel.app/api/logs/tail?format=text
//      https://2026-figurinha.vercel.app/api/logs/tail?level=error
app.get('/api/logs/tail', (req, res) => {
  const level = req.query.level;
  const fmt = req.query.format;
  const lines = level ? logRing.filter(l => l.level === level) : logRing;
  if (fmt === 'text') {
    res.type('text/plain; charset=utf-8');
    res.send(lines.map(l => `[${new Date(l.t).toISOString()}] [${l.level.toUpperCase()}] ${l.line}`).join('\n'));
    return;
  }
  res.json({ count: lines.length, max: LOG_RING_MAX, generationTimeoutMs, logs: lines });
});

app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    openaiGenerationEnabled: process.env.OPENAI_GENERATION_ENABLED === 'true',
    openaiImageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    openaiImageQuality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    openaiImageSize: process.env.OPENAI_IMAGE_SIZE || '1024x1536',
    assets: {
      mockup: fs.existsSync(mockupPath),
      regularFont: fs.existsSync(regularFontPath),
      boldFont: fs.existsSync(boldFontPath)
    },
    runtime: { vercel: isVercel, node: process.version },
    time: new Date().toISOString()
  });
});

app.get('/api/stickers/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).json({ error: 'Figurinha nao encontrada.' }); return; }
  res.json(job);
});

app.post('/api/stickers', upload.single('photo'), async (req, res) => {
  const startTime = Date.now();
  console.log(`[STSTICKER_GEN] [${new Date().toISOString()}] Nova requisicao de figurinha recebida.`);
  let usedModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  let usedPrompt = '';
  try {
    if (!req.file) {
      console.warn('[STSTICKER_GEN] Erro: Foto do craque nao enviada.');
      res.status(400).json({ error: 'Envie a foto do craque.' });
      return;
    }

    console.log(`[STSTICKER_GEN] Foto recebida: name="${req.file.originalname}" mime=${req.file.mimetype} size=${req.file.size}B (${(req.file.size/1024).toFixed(1)}KB)`);

    const data = normalizePayload(req.body);
    console.log('[STSTICKER_GEN] Dados recebidos:', JSON.stringify(data));

    // Pre-build the prompt for reference/logging in case of errors
    usedPrompt = buildEditPrompt(data);

    const missing = requiredFields.filter(field => !data[field]);
    if (missing.length) {
      console.warn(`[STSTICKER_GEN] Erro: Campos obrigatorios ausentes: ${missing.join(', ')}`);
      res.status(400).json({
        error: `Campos obrigatorios: ${missing.join(', ')}.`,
        debug: { model: usedModel, prompt: usedPrompt }
      });
      return;
    }

    const id = crypto.randomUUID();
    const originalPath = path.join(runtimeDir, `${id}-original.png`);
    const aiOutputPath = path.join(runtimeDir, `${id}-ai-output.png`);
    const stickerPath = path.join(outputDir, `${id}.png`);

    console.log(`[STSTICKER_GEN] ID Gerado: ${id}`);

    // 1. Salvar foto do usuário (referencia de identidade facial)
    //    NOTA: nao redimensionamos para um quadrado, mantemos a foto original
    //    para preservar a qualidade da identidade facial enviada para o modelo.
    const savePhotoStart = Date.now();
    await sharp(req.file.buffer)
      .rotate()
      .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toFile(originalPath);
    console.log(`[STSTICKER_GEN] Foto do usuario salva em ${Date.now() - savePhotoStart}ms`);

    // 2. Obter metadados do mockup (apenas para fallback local sem OpenAI)
    const mockupMeta = await sharp(mockupPath).metadata();
    const mockupWidth = mockupMeta.width;
    const mockupHeight = mockupMeta.height;
    console.log(`[STSTICKER_GEN] Mockup metadata. Largura: ${mockupWidth}px, Altura: ${mockupHeight}px`);

    // 3. Gerar a FIGURINHA COMPLETA via OpenAI
    //    O modelo recebe a figurinha-modelo (raphinha.png) E a foto do user,
    //    e gera a figurinha final completa em uma unica chamada.
    //    Nao recortamos mais o rosto: isso era a causa raiz do output ruim.
    const openAiStart = Date.now();
    console.log('[STSTICKER_GEN] Iniciando chamada OpenAI: figurinha completa + foto -> figurinha personalizada...');
    const resultFS = await generateFaceSwap(originalPath, aiOutputPath, data);
    usedModel = resultFS.model;
    usedPrompt = resultFS.prompt;
    const usedOpenAI = resultFS.usedOpenAI;
    console.log(`[STSTICKER_GEN] Chamada OpenAI concluida em ${Date.now() - openAiStart}ms. OpenAI usado: ${usedOpenAI}. Resultado: ${resultFS.path}`);

    // 4. Pos-processamento: aplica marca d'agua sobre o output da IA.
    //    Quando OpenAI esta ativo, o output JA E a figurinha final pronta.
    //    Quando OpenAI esta desativado (modo local), aplicamos composicao local.
    const composeStart = Date.now();
    const stickerBuffer = await composeSticker({
      id,
      data,
      aiResultPath: resultFS.path,
      usedOpenAI,
      mockupWidth,
      mockupHeight
    });
    console.log(`[STSTICKER_GEN] Figurinha final composta em ${Date.now() - composeStart}ms. Buffer size: ${(stickerBuffer.length/1024).toFixed(1)}KB`);

    const imageDataUrl = `data:image/png;base64,${stickerBuffer.toString('base64')}`;
    if (!isVercel) {
      await fsp.writeFile(stickerPath, stickerBuffer);
      console.log(`[STSTICKER_GEN] Arquivo final salvo localmente em: ${stickerPath}`);
    }

    const job = {
      id,
      status: 'done',
      imageUrl: isVercel ? '' : `/output/${id}.png`,
      imageDataUrl,
      usedOpenAI,
      createdAt: new Date().toISOString(),
      debug: {
        model: usedModel,
        prompt: usedPrompt
      }
    };
    jobs.set(id, job);

    console.log(`[STSTICKER_GEN] Sucesso! Processo total concluido em ${Date.now() - startTime}ms`);
    res.status(201).json(job);
  } catch (error) {
    const elapsedTotal = Date.now() - startTime;
    const normalized = normalizeError(error);
    console.error(`[STSTICKER_GEN] [FALHA APOS ${elapsedTotal}ms] Erro detalhado:`, error);
    console.error(`[STSTICKER_GEN] Erro normalizado enviado ao cliente:`, JSON.stringify(normalized));
    res.status(500).json({
      error: normalized.message || 'Nao foi possivel gerar a figurinha agora.',
      code: normalized.code,
      requestId: normalized.requestId,
      debug: {
        model: usedModel,
        prompt: usedPrompt
      }
    });
  }
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || 'Requisicao invalida.' });
});

if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`\n  Figurinha Copa rodando em http://localhost:${PORT}`);
    console.log(`  OpenAI gera imagens: ${process.env.OPENAI_GENERATION_ENABLED === 'true' ? 'sim' : 'nao'}`);
    console.log(`  Mockup: raphinha.png (${mockupPath})`);
    console.log(`  HTML principal: ${path.join(publicDir, 'index.html')}\n`);
  });
}

// =====================================================================
// FUNÇÕES
// =====================================================================

function normalizePayload(body) {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, String(value || '').trim()])
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDER (gpt-image-2)
// ─────────────────────────────────────────────────────────────────────────────
// Seguindo o padrao oficial do OpenAI Cookbook para gpt-image-2:
//   - Prompt em INGLES (recomendado pela docs oficial)
//   - Referenciar cada imagem por INDICE e DESCRICAO (Image 1, Image 2)
//   - Bloco "Change" + bloco "Preserve" (regra critica de edit endpoint)
//   - Texto literal entre ASPAS DUPLAS (typography hint)
//   - Lista explicita de tudo que NAO pode mudar (layout, faixas, logos,
//     numero verde "23", camisa, FIFA, BRASIL, Panini, fundos, etc)
//
// Refs:
//   - https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
//   - https://fal.ai/learn/tools/prompting-gpt-image-2
function buildEditPrompt(data) {
  const birthDay = (data.dia || '').padStart(2, '0');
  const monthNum = months[data.mes] || data.mes || '';
  const birthDate = `${birthDay}-${monthNum}-${data.ano || ''}`;
  const heightMeters = data.altura
    ? `${(Number(data.altura) / 100).toFixed(2).replace('.', ',')}m`
    : '';
  const weightStr = data.peso ? `${data.peso}kg` : '';
  const nameStr = (data.nome || '').toUpperCase();
  const clubStr = (data.clube || '').toUpperCase();

  return [
    'You are editing a Panini-style soccer World Cup 2026 trading card.',
    '',
    'Image 1: the reference trading card template (the existing sticker with a player on a Brazil national team kit).',
    'Image 2: the face reference photo of the new person who must replace the player on the card.',
    '',
    'TASK:',
    `Re-render Image 1 as a complete, single trading card, replacing ONLY the player's face/head with the face from Image 2, and replacing ONLY the textual stats with the values listed below. Keep the result as ONE single trading card, fully filling the output canvas.`,
    '',
    'PRESERVE (these must stay IDENTICAL to Image 1):',
    "- Overall card layout, framing, proportions, aspect ratio and composition.",
    "- The teal/cyan rounded outer card border.",
    "- The large green number \"23\" decoration on the background.",
    "- The yellow Brazilian national team jersey with the green CBF crest and \"BRASIL\" label, the Nike logo, and the star pattern.",
    "- The small FIFA World Cup trophy icon in the upper-right corner.",
    "- The Brazil flag and the vertical \"FIFA WORLD CUP 26\" / event branding on the right side.",
    "- The \"PANINI\" red logo at the bottom-right.",
    "- The dark teal info bars at the bottom that hold the player name and stats.",
    "- The lighting, colors, paper texture and overall finish of the original card.",
    "- The person's neckline, shoulders and how they meet the jersey (no floating head, natural anatomy).",
    '',
    'CHANGE (apply ONLY these edits):',
    '1. Replace the player\'s face and head with the face from Image 2. Match skin tone, hair, expression naturally to the body. Preserve the identity of the person in Image 2 (same facial features, same proportions, same hairline). Photoreal integration with the body, no cut-out look.',
    `2. Replace the large player surname text in the info bar with: "${nameStr}".`,
    `3. Replace the birth-date / height / weight line with: "${birthDate} | ${heightMeters} | ${weightStr}".`,
    `4. Replace the club name in the lower bar with: "${clubStr}".`,
    '',
    'TYPOGRAPHY:',
    '- Render every replaced text VERBATIM, in white, in the same bold sans-serif style as the original card, with the same size and placement.',
    '- No extra words, no duplicate text, no watermark, no extra logos.',
    '',
    'OUTPUT:',
    '- A single, complete Panini-style trading card, photoreal, sharp, filling the entire output canvas.',
    '- Do NOT output a card-inside-a-card, do NOT output just a face crop, do NOT output a collage.',
  ].join('\n');
}

// Envia a FIGURINHA COMPLETA (raphinha.png) + a FOTO DO USUARIO para a OpenAI,
// e recebe de volta a figurinha final pronta. Em modo local (sem OpenAI),
// retorna null para sinalizar que a composicao deve ser feita localmente.
async function generateFaceSwap(userPhotoPath, outputPath, data) {
  const canUseOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_GENERATION_ENABLED === 'true';
  const modelName = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const prompt = buildEditPrompt(data);

  if (!canUseOpenAI) {
    console.log('[OPENAI_FS] OpenAI desativada (OPENAI_GENERATION_ENABLED=false ou chave ausente). Sera feita composicao local sobre o mockup.');
    return { path: null, prompt, model: modelName, usedOpenAI: false };
  }

  await assertReadable(userPhotoPath, 'SOURCE_IMAGE_MISSING');
  await assertReadable(mockupPath, 'MOCKUP_MISSING');

  const qualitySetting = process.env.OPENAI_IMAGE_QUALITY || 'medium';
  const sizeSetting = process.env.OPENAI_IMAGE_SIZE || '1024x1536';
  console.log(`[OPENAI_FS] Inicializando cliente OpenAI. Modelo: "${modelName}", Qualidade: "${qualitySetting}", Size: "${sizeSetting}"`);

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: generationTimeoutMs
  });

  const uploadStart = Date.now();

  // CORRECAO CRITICA: enviamos a FIGURINHA INTEIRA (raphinha.png) como Image 1,
  // nao mais um recorte do rosto. Isso da contexto completo para o modelo
  // entender layout, cores, fontes, logos e geometria da figurinha.
  const templateUpload = await toFile(
    await fsp.readFile(mockupPath),
    'image-1-reference-card.png',
    { type: 'image/png' }
  );

  // Image 2: foto do rosto do usuario (referencia de identidade).
  const faceUpload = await toFile(
    await fsp.readFile(userPhotoPath),
    'image-2-face-reference.png',
    { type: 'image/png' }
  );
  console.log(`[OPENAI_FS] Arquivos preparados em ${Date.now() - uploadStart}ms (template completo + foto do user)`);

  console.log(`[OPENAI_FS] Disparando edit() na API OpenAI. Prompt length: ${prompt.length} chars`);

  const apiStart = Date.now();
  // IMPORTANTE: a ordem do array `image` importa - Image 1 primeiro, Image 2 depois,
  // batendo com a numeracao usada no prompt.
  const response = await client.images.edit({
    model: modelName,
    image: [templateUpload, faceUpload],
    prompt,
    size: sizeSetting,
    quality: qualitySetting,
    n: 1
  });
  const apiDuration = Date.now() - apiStart;
  console.log(`[OPENAI_FS] OpenAI respondeu com sucesso em ${apiDuration}ms`);

  const b64 = response.data?.[0]?.b64_json;
  const url = response.data?.[0]?.url;

  let imageBuffer;
  if (b64) {
    console.log('[OPENAI_FS] Recebido formato Base64 (b64_json). Convertendo para buffer...');
    imageBuffer = Buffer.from(b64, 'base64');
  } else if (url) {
    console.log(`[OPENAI_FS] Recebido formato URL: ${url}. Iniciando download da imagem...`);
    const fetchStart = Date.now();
    const resFetch = await fetch(url);
    if (!resFetch.ok) {
      throw new Error(`Falha ao baixar imagem gerada da URL: ${resFetch.statusText}`);
    }
    const arrayBuffer = await resFetch.arrayBuffer();
    imageBuffer = Buffer.from(arrayBuffer);
    console.log(`[OPENAI_FS] Download concluido em ${Date.now() - fetchStart}ms`);
  } else {
    throw new Error('A API da OpenAI nao retornou nem base64 nem URL da imagem.');
  }

  await fsp.writeFile(outputPath, imageBuffer);
  console.log(`[OPENAI_FS] Figurinha final da IA salva em: ${outputPath}`);
  return { path: outputPath, prompt, model: modelName, usedOpenAI: true };
}

// Compose final sticker:
//  - usedOpenAI=true : o output da IA JA E a figurinha final. So aplicamos
//    a marca d'agua/preview por cima. NAO recolamos rosto, NAO repintamos
//    nenhuma faixa - tudo isso ja foi feito pelo gpt-image-2.
//  - usedOpenAI=false: modo local (sem custo). Cai no fallback antigo de
//    colar o crop do mockup + redesenhar dados via SVG.
async function composeSticker({ id, data, aiResultPath, usedOpenAI, mockupWidth, mockupHeight }) {
  if (usedOpenAI && aiResultPath) {
    await assertReadable(aiResultPath, 'AI_RESULT_MISSING');
    const aiMeta = await sharp(aiResultPath).metadata();
    const width = aiMeta.width;
    const height = aiMeta.height;

    // Apenas a marca d'agua sobre o output da IA.
    const watermarkSvg = buildWatermarkSvg({ id, width, height });

    return sharp(aiResultPath)
      .ensureAlpha()
      .composite([
        {
          input: Buffer.from(watermarkSvg),
          left: 0,
          top: 0
        }
      ])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // ── FALLBACK LOCAL (sem OpenAI) ─────────────────────────────────────────
  // Mantemos a logica antiga: pegamos o mockup do Raphinha e desenhamos
  // os textos + marca d'agua. Util para dev local sem gastar credito.
  await assertReadable(mockupPath, 'MOCKUP_MISSING');

  const width = mockupWidth;
  const height = mockupHeight;
  const textLayout = getTemplateTextLayout(width, height);
  const svgContent = buildStickerSvg({ id, data, width, height, textLayout });

  return sharp(mockupPath)
    .ensureAlpha()
    .composite([
      {
        input: Buffer.from(svgContent),
        left: 0,
        top: 0
      }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Marca d'agua minimalista, aplicada por cima do output da IA.
function buildWatermarkSvg({ id, width, height }) {
  const watermark = escapeXml(
    process.env.WATERMARK_TEXT || 'PREVIEW PROTEGIDO - DIREITOS AUTORAIS'
  );
  const jobMark = escapeXml(id.slice(0, 8).toUpperCase());
  const wmFont = Math.round(height * 0.028);

  // Linhas diagonais de marca d'agua.
  const wmLines = Array.from({ length: 22 }, (_, row) => {
    const y = Math.round(-height * 0.2 + row * height * 0.085);
    return `<text x="${Math.round(-width * 0.6)}" y="${y}" fill="#FFFFFF" fill-opacity="0.16" font-family="Arial, Helvetica, sans-serif" font-size="${wmFont}px" font-weight="700" letter-spacing="2px">${watermark} • ${jobMark}</text>`;
  }).join('');

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-25 ${width / 2} ${height / 2})">${wmLines}</g>
      <text
        x="${width * 0.5}"
        y="${height * 0.93}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${Math.round(height * 0.018)}px"
        font-weight="700"
        fill="#FFFFFF"
        fill-opacity="0.55"
        text-anchor="middle"
        letter-spacing="1px"
      >PREVIEW • ${jobMark}</text>
    </svg>
  `;
}

function buildStickerSvg({ id, data, width, height, textLayout }) {
  const birthDate = `${data.dia}-${months[data.mes] || data.mes}-${data.ano}`;
  const heightMeters = (Number(data.altura) / 100).toFixed(2).replace('.', ',');
  const safeName = escapeXml(data.nome.toUpperCase()).slice(0, 26);
  const safeClub = escapeXml(data.clube.toUpperCase()).slice(0, 32);
  const details = escapeXml(`${birthDate} | ${heightMeters}m | ${data.peso}kg`);
  const watermark = escapeXml(
    process.env.WATERMARK_TEXT || 'PREVIEW PROTEGIDO - DIREITOS AUTORAIS'
  );
  const jobMark = escapeXml(id.slice(0, 8).toUpperCase());

  const fontSize = {
    name: textLayout.font.name,
    details: textLayout.font.details,
    club: textLayout.font.club,
    wm: Math.round(height * 0.028),
    wmSmall: Math.round(height * 0.018)
  };

  // Linhas de marca d'água diagonais (com estilos inline para garantir a renderização no SVG)
  const wmLines = Array.from({ length: 18 }, (_, row) => {
    const y = Math.round(-height * 0.15 + row * height * 0.085);
    return `<text x="${Math.round(-width * 0.6)}" y="${y}" fill="#FFFFFF" fill-opacity="0.18" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize.wm}px" font-weight="700" letter-spacing="2px">${watermark} • ${jobMark}</text>`;
  }).join('');

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <!-- Marca d'água diagonal -->
      <g transform="rotate(-25 ${width / 2} ${height / 2})">${wmLines}</g>

      <!-- Recria apenas as faixas originais para apagar os dados antigos antes do novo texto -->
      <rect
        x="${textLayout.mainBar.left}"
        y="${textLayout.mainBar.top}"
        width="${textLayout.mainBar.width}"
        height="${textLayout.mainBar.height}"
        rx="${textLayout.mainBar.radius}"
        fill="${textLayout.barColor}"
      />
      <rect
        x="${textLayout.clubBar.left}"
        y="${textLayout.clubBar.top}"
        width="${textLayout.clubBar.width}"
        height="${textLayout.clubBar.height}"
        rx="${textLayout.clubBar.radius}"
        fill="${textLayout.barColor}"
      />

      <!-- Nome do jogador -->
      <text
        x="${textLayout.name.x}"
        y="${textLayout.name.y}"
        font-family="Arial, Helvetica, sans-serif" 
        font-size="${fontSize.name}px" 
        font-weight="700" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="2px"
      >${safeName}</text>

      <!-- Detalhes: data | altura | peso -->
      <text
        x="${textLayout.details.x}"
        y="${textLayout.details.y}"
        font-family="Arial, Helvetica, sans-serif" 
        font-size="${fontSize.details}px" 
        font-weight="400" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="1px"
        opacity="0.9"
      >${details}</text>

      <!-- Clube -->
      <text
        x="${textLayout.club.x}"
        y="${textLayout.club.y}"
        font-family="Arial, Helvetica, sans-serif" 
        font-size="${fontSize.club}px" 
        font-weight="700" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="1.5px"
      >${safeClub}</text>

      <!-- Marca d'água small -->
      <text 
        x="${width * 0.5}" 
        y="${height * 0.72}" 
        font-family="Arial, Helvetica, sans-serif" 
        font-size="${fontSize.wmSmall}px" 
        font-weight="700" 
        fill="#FFFFFF" 
        fill-opacity="0.6" 
        text-anchor="middle" 
        transform="rotate(-25 ${width * 0.5} ${height * 0.72})"
        letter-spacing="1px"
      >PREVIEW • ${jobMark}</text>
    </svg>
  `;
}

function getTemplateTextLayout(width, height) {
  const sx = width / 720;
  const sy = height / 960;
  return {
    barColor: '#1e8689',
    mainBar: scaleBox({ left: 35, top: 804, width: 518, height: 91, radius: 38 }, sx, sy),
    clubBar: scaleBox({ left: 35, top: 906, width: 452, height: 43, radius: 22 }, sx, sy),
    name: { x: Math.round(294 * sx), y: Math.round(852 * sy) },
    details: { x: Math.round(294 * sx), y: Math.round(881 * sy) },
    club: { x: Math.round(261 * sx), y: Math.round(935 * sy) },
    font: {
      name: Math.round(42 * sy),
      details: Math.round(29 * sy),
      club: Math.round(27 * sy)
    }
  };
}

function scaleBox(rect, sx, sy) {
  return {
    left: Math.round(rect.left * sx),
    top: Math.round(rect.top * sy),
    width: Math.round(rect.width * sx),
    height: Math.round(rect.height * sy),
    radius: Math.round(rect.radius * Math.min(sx, sy))
  };
}

function fontDataUri(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return `data:font/truetype;base64,${data}`;
}

async function assertReadable(filePath, code) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch {
    const error = new Error(`${code}: ${filePath}`);
    error.code = code;
    throw error;
  }
}

function normalizeError(error) {
  const status = error?.status || error?.response?.status;
  const requestId = error?.request_id || error?.requestID || error?.headers?.['x-request-id'];
  let code = error?.code || error?.type || 'GENERATION_FAILED';
  if (status === 401) code = 'OPENAI_AUTH_FAILED';
  if (status === 402 || /billing|quota|credit/i.test(error?.message || '')) code = 'OPENAI_BILLING_OR_QUOTA';
  if (status === 429) code = 'OPENAI_RATE_LIMIT';
  if (status >= 500) code = 'OPENAI_UPSTREAM_ERROR';
  return { code, status, requestId, message: error?.message || 'Unknown error' };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export default app;
