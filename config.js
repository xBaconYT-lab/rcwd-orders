// ลิงก์ Web app ของ Apps Script (Deploy > New deployment > Web app) ต้องลงท้ายด้วย /exec
// ไม่มีรหัสผ่านอยู่ในไฟล์นี้ รหัสเก็บไว้ในสคริปต์ของ Google Sheet เท่านั้น
// rcwd.leamm.com = รอบ 1 (ชีต Rachawadee Shirt Pre-Order), rcwd2.leamm.com = รอบเก็บตก (ชีต RCWD Jersey 2026 รอบเก็บตก)
// ทั้งสองโดเมนใช้ไฟล์ชุดเดียวกัน (rcwd2/ ส่งต่อไปที่ rcwd.leamm.com) ต่างกันแค่ค่าที่ไฟล์นี้เลือกตามโดเมน
(() => {
  const ROUND1 = 'https://script.google.com/macros/s/AKfycbwsher6qjJtSS2A2EFbpej-gHYczgew1M4ZSfny7EzjK6lCz6-ubb3cqVz30xwFdeUpLg/exec';
  const ROUND2 = 'https://script.google.com/macros/s/AKfycbx9k7lw--Ez-UyspogaHUtwzrpN-JPXSQyTUQyzITDrwXp2JMnfk5U2onpu15Ibq-QYXA/exec';
  const rcwd2 = location.hostname === 'rcwd2.leamm.com';
  window.RCWD_API_URL = rcwd2 ? ROUND2 : ROUND1;
  // เช็กลิสต์ (ทั้งสองโดเมน) รวมทั้งสองรอบในรายการเดียว เรียงตามชั้น/ห้อง (ใช้ชื่อผู้ใช้/รหัสผ่านเดียวกันทั้งสองชีต)
  window.RCWD_CHECKLIST_ROUNDS = [{ label: 'รอบ 1', url: ROUND1 }, { label: 'รอบเก็บตก', url: ROUND2 }];
  // ตัวส่งอีเมล (Cloudflare Worker ใน mailer/) ส่งผ่าน Gmail SMTP ว่าง = ให้ Apps Script ส่งเอง
  // rcwd2 ยังไม่ได้ตั้งการส่งอีเมล (mailer ผูกกับชีตรอบ 1)
  window.RCWD_MAILER_URL = rcwd2 ? '' : 'https://rcwd-mailer.weeraphat-work-th.workers.dev';
})();
