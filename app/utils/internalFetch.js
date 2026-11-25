'use strict';

/**
 * Cliente HTTP para chamadas internas (loopback) à própria API.
 *
 * O servidor principal usa HTTP; APP_SCHEME pode ser definido explicitamente
 * quando o listener local estiver configurado para HTTPS.
 *
 * Para HTTPS, usamos o módulo nativo e limitamos a opção de certificado
 * autoassinado a essa requisição, sem desativar a validação TLS do processo
 * inteiro.
 */

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;

/** URL base da própria API, derivada das variáveis de ambiente. */
function getBaseUrl() {
  const port = process.env.APP_PORT || 3000;
  const scheme = String(process.env.APP_SCHEME || 'http').toLowerCase() === 'http' ? 'http' : 'https';
  return `${scheme}://localhost:${port}`;
}

/**
 * Executa um POST JSON contra a própria API e devolve uma resposta com a mesma
 * interface usada antes (`ok`, `status`, `json()`, `text()`), para não alterar
 * os pontos de chamada.
 *
 * @param {string} path Caminho interno, ex.: '/ia/generate-exercise'
 * @param {object} body Corpo enviado como JSON
 * @param {{timeoutMs?: number, baseUrl?: string}} [options]
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<object>, text: () => Promise<string>}>}
 */
function postJson(path, body, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = getBaseUrl() } = options;
  const url = new URL(path, baseUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const payload = JSON.stringify(body === undefined ? {} : body);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        // Loopback com certificado autoassinado: a validação fica desligada
        // somente nesta requisição, nunca no processo inteiro.
        ...(isHttps ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          const status = res.statusCode;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => raw,
            json: async () => {
              try {
                return JSON.parse(raw);
              } catch {
                throw new Error(`Resposta não é JSON válido: ${raw.slice(0, 200)}`);
              }
            }
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Tempo esgotado (${timeoutMs}ms) ao chamar ${url.href}`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { postJson, getBaseUrl };
