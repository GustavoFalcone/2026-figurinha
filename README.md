# Figurinha Copa 2026

Fluxo de captura de dados, upload de foto, geração de figurinha em cima do mockup da Copa e encaminhamento para checkout.

## Rodar

```bash
npm install
npm start
```

Acesse `http://localhost:3100`.

## Produção

Configure as variáveis de ambiente na plataforma de deploy:

```bash
NODE_ENV=production
OPENAI_GENERATION_ENABLED=true
OPENAI_API_KEY=sk-...
OPENAI_IMAGE_MODEL=gpt-image-1.5
OPENAI_IMAGE_QUALITY=high
WATERMARK_TEXT=ESTA FIGURINHA TEM DIREITOS AUTORAIS - PREVIEW PROTEGIDO - NAO COPIAR
```

Na Vercel nao configure `PORT`; a propria plataforma cuida do roteamento do dominio.

Para desenvolvimento local sem gastar saldo:

```bash
OPENAI_GENERATION_ENABLED=false
```

Com `false`, o backend ainda gera a figurinha final localmente usando `sharp`, aplicando a foto enviada no mockup, os dados coletados e a marca d'água. Com `true`, a OpenAI gera o jogador recortado com rosto da pessoa e camisa do Brasil antes da composição final.

## Configurar links

Edite as constantes em `public/index.html`:

```js
const CONFIG = {
  checkoutUrl: 'https://www.zuckpay.com.br/checkout/sua-figurinha-da-copa-2026'
};
```

## Endpoints

- `POST /api/stickers`: recebe `multipart/form-data` com `photo`, `nome`, `email`, `dia`, `mes`, `ano`, `clube`, `peso`, `altura`.
- `GET /api/stickers/:id`: retorna o status e a URL da figurinha.
- `GET /health`: status do servidor e flags de OpenAI.

## Fluxo

1. Usuário informa nome, foto, nascimento, e-mail, clube, peso e altura.
2. A tela de carregamento valida a foto e segue para os dados.
3. A tela final envia os dados e a foto para o backend.
4. O backend gera a imagem final com mockup, dados e marca d'água.
5. A tela de resultado mostra a figurinha gerada e o botão de checkout.
