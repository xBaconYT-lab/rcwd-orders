# RCWD Jersey 2026

หน้าดูออเดอร์เสื้อและหมวกของราชาวดี (rcwd.leamm.com)

- เลือกดู Jersey เขียว / Jersey ขาว / หมวก RCWD กรองตามวันที่สั่ง ค้นหา (รวมเลขออเดอร์ เช่น #12) และดาวน์โหลดเป็น Excel
- ข้อมูลดึงสดจากแท็บ Jersey เขียว / Jersey ขาว / หมวก RCWD ใน Google Sheet ผ่าน Apps Script (`doPost`)
  แก้ข้อมูลในชีตเมื่อไหร่ หน้าเว็บก็เห็นตาม แถวที่พิมพ์เพิ่มเองในชีตจะขึ้นป้าย "เพิ่มเอง"
- ไม่มีข้อมูลลูกค้าหรือรหัสผ่านเก็บไว้ใน repo นี้
- ลิงก์สลิปเปิดใน Google Drive ได้เฉพาะบัญชีเจ้าของฟอร์ม

## ตั้งค่า

1. ใน Apps Script ของชีตคำตอบ: Deploy > New deployment > Web app
   (Execute as: Me, Who has access: Anyone) แล้วก๊อปลิงก์ที่ลงท้าย `/exec`
2. ใส่ลิงก์นั้นใน `config.js`
3. DNS ของ leamm.com: เพิ่ม CNAME record `rcwd` ชี้ไปที่ `xbaconyt-lab.github.io`

แก้โค้ด Apps Script แล้วต้อง Deploy > Manage deployments > Edit > Version: New version เว็บถึงจะใช้โค้ดใหม่

ดูตัวอย่างหน้าตาด้วยข้อมูลสมมติได้ที่ `?demo`
