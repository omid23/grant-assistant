// JSON in and out over node:http.

export class HttpError extends Error {
  constructor(status, code, reply) {
    super(reply);
    this.status = status;
    this.code = code;
    this.reply = reply;
  }
}

export function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export const sendError = (res, error) => send(res, error.status, { error: error.code, reply: error.reply });

/** Read a JSON object body, at most maxBytes long. */
export function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, 'body_too_large', `The request body is larger than ${maxBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return reject(new HttpError(400, 'invalid_json', 'The request body must be a JSON object.'));
      try {
        const body = JSON.parse(text);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return reject(new HttpError(400, 'invalid_json', 'The request body must be a JSON object.'));
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'The request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}
