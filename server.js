// ---- Imports ----
import cron from "node-cron";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { getPool, sql as mssql } from "./db.js"; //

import { StockStatusService } from "./services/StockStatusService.js";
import { ItemMovementService } from "./services/ItemMovementService.js"; // <-- เพิ่ม

// เชื่อมต่อ DB ทันที + log
getPool()
  .then(() => console.log("[DB] connected"))
  .catch(err => console.error("[DB] connect fail:", err?.message || err));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- App base ----
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public
// app.use(express.urlencoded({ extended: true }));

// สร้าง service instances
const stockService  = new StockStatusService();
const itemMovementService = new ItemMovementService();

// // สร้าง item-movement
 app.get("/api/item-movement", async (req, res) => {
  try {
    const { months, excludeCurrent, countMode, branch, sortBy, order } = req.query;
    const result = await stockService.getStockStatus({ months, excludeCurrent, countMode, branch, sortBy, order });
    const rows = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
    res.json({ rows });
  } catch (e) {
    console.error("/api/stock-status error:", e);
    res.status(500).json({ rows: [], error: e.message || "Failed" });
  }
});


// ---- Sanity check ----
app.get("/api/ping", (req, res) => res.json({ ok: true, now: new Date().toISOString() }));


// ---- 2) Average Demand จากคอลัมน์รายเดือน ----
app.get("/api/stock-status", async (req, res) => {
  try {
    // เพิ่ม sortBy, order เข้ามาด้วย
    const { months, excludeCurrent, countMode, branch, sortBy, order } = req.query;

    // ส่งต่อไปที่ service
    const data = await stockService.getStockStatus({
      months, excludeCurrent, countMode, branch, sortBy, order
    });

    res.json(data);
  } catch (e) {
    console.error("/api/stock-status:", e);
    res.status(500).json({ error: e.message || "Failed" });
  }
});

function extractYmd(req) {
  const q = req?.query ?? {};
  const b = req?.body  ?? {};
  const date = String(q.date ?? q.Date ?? b.date ?? b.Date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error("invalid-date"); err.code = "INVALID_DATE";
    throw err;
  }
  return date;
}

app.get("/api/stock-status/snapshot", async (req, res) => {
  try {
    const date = extractYmd(req);
    const r = await saveSnapshot(date);
    if (!r.ok) return res.status(500).json(r);
    res.json(r);
  } catch (e) {
    if (e.code === "INVALID_DATE") return res.status(400).json({ ok:false, error:"invalid date (YYYY-MM-DD)" });
    console.error("[snapshot GET] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post("/api/stock-status/snapshot", async (req, res) => {
  try {
    const date = extractYmd(req);
    const r = await saveSnapshot(date);
    if (!r.ok) return res.status(500).json(r);
    res.json(r);
  } catch (e) {
    if (e.code === "INVALID_DATE") return res.status(400).json({ ok:false, error:"invalid date (YYYY-MM-DD)" });
    console.error("[snapshot POST] error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ดึง snapshot ของวันนั้น ๆ
app.get("/api/snapshots", async (req, res) => {
  try {
    // รับ date=YYYY-MM-DD (ถ้า input type="date" ก็ส่งค่านี้มาอยู่แล้ว)
    const date = String(req.query?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok:false, error:"invalid date (YYYY-MM-DD)" });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("d", sql.Date, date);

    const rs = await request.query(`
      SELECT
        snapshot_date,
        branch_code, sku_number, product_name,
        average_demand, safety_stock, reorder_point, min_qty,
        onhand_qty, backlog, turnover,
        stdev6, zscore, lt_days, status
      FROM dbo.StockStatusSnapshot
      WHERE snapshot_date = @d
      ORDER BY branch_code, sku_number;
    `);

    // map เป็นคีย์แบบเดียวกับตารางหน้าเว็บ
    const rows = rs.recordset.map(r => ({
      branchCode:     r.branch_code,
      skuNumber:      r.sku_number,
      productName:    r.product_name,
      averageDemand:  r.average_demand,
      safetyStock:    r.safety_stock,
      reorderPoint:   r.reorder_point,
      minQty:         r.min_qty,
      onHandQty:      r.onhand_qty,
      backlog:        r.backlog,
      turnOver:       r.turnover,
      stdev6:         r.stdev6,
      zScore:         r.zscore,
      ltDays:         r.lt_days,
      status:         r.status
    }));

    res.json({ ok:true, date, count: rows.length, rows });
  } catch (e) {
    console.error("/api/snapshots error:", e);
    res.status(500).json({ ok:false, error: e.message });
  }
});



//snapshot
// "dd/mm/yyyy" -> "yyyy-mm-dd"
function dmyToYmd(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const [_, d, mth, y] = m;
  return `${y}-${String(mth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

let snapshotLock = false; // กันรันซ้อน

async function saveSnapshot(dateStr) {
  if (snapshotLock) return { ok:false, reason:"running" };
  snapshotLock = true;
  try {
    // 1) ดึงทั้งตาราง (ใช้พารามิเตอร์เดียวกับหน้า UI ที่ต้องการ)
    const data = await stockService.getStockStatus({ months:6, excludeCurrent:true });
    const rows = data.rows || [];

    // 2) upsert ลงตาราง snapshot (เหมือน endpoint ที่ผมให้ก่อนหน้า)
    const pool = await getPool();
    const request = pool.request();
    request.input("snapshot_date", mssql.Date, dateStr);
    request.input("payload",      mssql.NVarChar(mssql.MAX), JSON.stringify(rows));

    const sql = `
      WITH j AS (
        SELECT *
        FROM OPENJSON(@payload)
        WITH (
          branchCode    varchar(10)   '$.branchCode',
          skuNumber     varchar(64)   '$.skuNumber',
          productName   nvarchar(255) '$.productName',
          averageDemand int           '$.averageDemand',
          safetyStock   int           '$.safetyStock',
          reorderPoint  int           '$.reorderPoint',
          minQty        int           '$.minQty',
          onHandQty     int           '$.onHandQty',
          backlog       int           '$.backlog',
          turnOver      decimal(18,2) '$.turnOver',
          stdev6        int           '$.stdev6',
          zScore        decimal(6,2)  '$.zScore',
          ltDays        int           '$.ltDays',
          status        nvarchar(30)  '$.status'
        )
      )
      MERGE dbo.StockStatusSnapshot AS t
      USING (SELECT @snapshot_date AS snapshot_date, * FROM j) AS s
      ON  t.snapshot_date = s.snapshot_date
      AND t.branch_code   = s.branchCode
      AND t.sku_number    = s.skuNumber
      WHEN MATCHED THEN
        UPDATE SET
          t.product_name   = s.productName,
          t.average_demand = s.averageDemand,
          t.safety_stock   = s.safetyStock,
          t.reorder_point  = s.reorderPoint,
          t.min_qty        = s.minQty,
          t.onhand_qty     = s.onHandQty,
          t.backlog        = s.backlog,
          t.turnover       = s.turnOver,
          t.stdev6         = s.stdev6,
          t.zscore         = s.zScore,
          t.lt_days        = s.ltDays,
          t.status         = s.status,
          t.created_at     = sysdatetime()
      WHEN NOT MATCHED THEN
        INSERT (snapshot_date, branch_code, sku_number, product_name, average_demand, safety_stock, reorder_point, min_qty, onhand_qty, backlog, turnover, stdev6, zscore, lt_days, status)
        VALUES (s.snapshot_date, s.branchCode, s.skuNumber, s.productName, s.averageDemand, s.safetyStock, s.reorderPoint, s.minQty, s.onHandQty, s.backlog, s.turnOver, s.stdev6, s.zScore, s.ltDays, s.status);
    `;
    await request.query(sql);
    console.log(`[snapshot] saved ${rows.length} rows for ${dateStr}`);
    return { ok:true, saved:rows.length, date:dateStr };
  } catch (err) {
    console.error("[snapshot] error:", err);
    return { ok:false, error: err.message };
  } finally {
    snapshotLock = false;
  }
}

// รันทุกวันเวลา 01:05 (Asia/Bangkok) แล้วเก็บ snapshot ของ "เมื่อวาน"
cron.schedule("5 1 * * *", async () => {
  const now = new Date();
  // เมื่อวานตามเวลาไทย
  const tz = "Asia/Bangkok";
  const offsetNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  offsetNow.setDate(offsetNow.getDate() - 1);
  const dateStr = ymd(offsetNow, tz); // YYYY-MM-DD

  const r = await saveSnapshot(dateStr);
  if (!r.ok) console.error("[cron] snapshot failed:", r.error || r.reason);
}, { timezone: "Asia/Bangkok" });

 

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Open UI: http://localhost:${PORT}/Item_Movement.html`);
});