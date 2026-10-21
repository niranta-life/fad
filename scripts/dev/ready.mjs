import http from 'node:http';

export function getReady(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: '127.0.0.1', port, path: '/health/ready', timeout: 1500 },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 256) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}

export function bodyIsReady(body) {
  try {
    return JSON.parse(body).status === 'ready';
  } catch {
    return false;
  }
}

export async function waitReady(port) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = await getReady(port);
    if (result && result.status === 200 && bodyIsReady(result.body)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}
