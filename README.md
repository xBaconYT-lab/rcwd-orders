# RCWD Jersey 2026

หน้าดูออเดอร์เสื้อและหมวกของราชาวดี (rcwd.leamm.com)

- เลือกดูเสื้อหรือหมวก กรองตามวันที่สั่ง ค้นหา และดาวน์โหลดเป็น Excel
- ข้อมูลดึงสดจาก Google Sheet ผ่าน Apps Script (`doPost`) ไม่มีข้อมูลลูกค้าหรือรหัสผ่านเก็บไว้ใน repo นี้
- ลิงก์สลิปเปิดใน Google Drive ได้เฉพาะบัญชีเจ้าของฟอร์ม

## ตั้งค่า

1. ใน Apps Script ของชีตคำตอบ: Deploy > New deployment > Web app
   (Execute as: Me, Who has access: Anyone) แล้วก๊อปลิงก์ที่ลงท้าย `/exec`
2. ใส่ลิงก์นั้นใน `config.js`
3. DNS ของ leamm.com: เพิ่ม CNAME record `rcwd` ชี้ไปที่ `xbaconyt-lab.github.io`

ดูตัวอย่างหน้าตาด้วยข้อมูลสมมติได้ที่ `?demo`
