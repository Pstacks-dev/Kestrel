import tls from 'node:tls';
import { createInterface } from 'node:readline';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing email configuration: ${name}`);
  return value;
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function encodeBody(value) {
  return Buffer.from(String(value), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}

export async function sendEmail({ to, subject, text, html }) {
  const host = requiredEnv('SMTP_HOST');
  const user = requiredEnv('SMTP_USER');
  const pass = requiredEnv('SMTP_PASS');
  const from = process.env.SMTP_FROM_EMAIL || user;
  const fromName = process.env.SMTP_FROM_NAME || 'Kestrel';
  const port = Number(process.env.SMTP_PORT || 465);

  if (port !== 465) {
    throw new Error('Kestrel SMTP currently requires implicit TLS on port 465.');
  }
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) {
    throw new Error('Invalid SMTP sender or recipient email address.');
  }

  const socket = tls.connect({ host, port, servername: host });
  socket.setTimeout(20_000, () => socket.destroy(new Error('SMTP connection timed out')));
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  async function readResponse(expected) {
    const response = [];
    let code = null;
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error('SMTP connection closed unexpectedly.');
      const line = next.value;
      response.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) continue;
      code = Number(match[1]);
      if (match[2] === ' ') break;
    }
    if (!expected.includes(code)) {
      throw new Error(`SMTP rejected a command (${code}): ${response.join(' | ').slice(0, 500)}`);
    }
    return response.join('\n');
  }

  async function command(value, expected) {
    socket.write(`${value}\r\n`);
    return readResponse(expected);
  }

  try {
    await readResponse([220]);
    await command('EHLO kestrel.local', [250]);
    await command('AUTH LOGIN', [334]);
    await command(Buffer.from(user).toString('base64'), [334]);
    await command(Buffer.from(pass).toString('base64'), [235]);
    await command(`MAIL FROM:<${from}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command('DATA', [354]);

    const boundary = `kestrel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message = [
      `From: ${encodeHeader(fromName)} <${from}>`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(html || text),
      `--${boundary}--`,
      '',
    ].join('\r\n').replace(/(^|\r\n)\./g, '$1..');

    socket.write(`${message}\r\n.\r\n`);
    await readResponse([250]);
    await command('QUIT', [221]);
  } finally {
    lines.close();
    socket.end();
  }
}
