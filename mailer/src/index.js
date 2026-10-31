// จุดเข้า Worker: ผูก SMTP จริง (worker-mailer ใช้ TCP socket ของ Cloudflare) กับตัวจัดการใน handler.js
import { WorkerMailer } from 'worker-mailer';
import { handle } from './handler.js';

export default {
  fetch: (req, env) => handle(req, env, { connect: (o) => WorkerMailer.connect(o), fetch: (...a) => fetch(...a) }),
};
