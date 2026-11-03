// rcwd2.leamm.com แสดงไฟล์ชุดเดียวกับ rcwd.leamm.com ทุกไฟล์ ลิงก์ redirect (เช่น /fonts > /fonts/) ให้อยู่ที่โดเมนเดิม
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const host = url.host;
    url.host = 'rcwd.leamm.com';
    const res = await fetch(new Request(url, req), { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (!loc) return res;
    const out = new Response(res.body, res);
    out.headers.set('location', loc.replace(/^https?:\/\/rcwd\.leamm\.com/, 'https://' + host));
    return out;
  },
};
