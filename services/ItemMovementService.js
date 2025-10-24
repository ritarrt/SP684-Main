import { getPool, sql } from "../db.js";
import { StockStatusService } from "./StockStatusService.js";

/**
 * ItemMovementService
 * - ดึงข้อมูล Item Movement จากตารางของคุณ (เช่น ItemMovement)
 * - ผสานค่าที่คำนวณจาก StockStatusService (turnOver, trend, sales6 ฯลฯ)
 * - ทำให้ค่า trend ในหน้านี้ "เท่ากับ" หน้า Stock Status ทุกประการ
 */
export class ItemMovementService {
  constructor() {
    this.stockStatusService = new StockStatusService();
  }

  /**
   * opts:
   *  - months: 3|6|12 (default 6)
   *  - branch: รหัสสาขา (ถ้ามี)
   *  - sortBy: คีย์สำหรับเรียง
   *  - order: asc|desc
   */
  async getItemMovement(opts = {}) {
    const pool = await getPool();

    const months = [3, 6, 12].includes(Number(opts.months)) ? Number(opts.months) : 6;
    const branch = String(opts.branch || "").trim();
    const order = String(opts.order || "asc").toLowerCase() === "desc" ? "desc" : "asc";

    // 1) ดึงผลคำนวณจาก StockStatusService (เป็น source of truth สำหรับ trend/turnOver)
    //    หมายเหตุ: ไม่จำเป็นต้องส่ง sort ไปก็ได้ เพราะเราจะ sort ทีหลังบนผลรวม
    const stockRows = await this.stockStatusService.getStockStatus({ months, branch });

    // ทำ map เพื่อค้นหาเร็วด้วย key = branch#sku
    const keyOf = (b, s) => `${String(b||"").trim()}#${String(s||"").trim()}`;
    const stockMap = new Map();
    for (const s of (stockRows || [])) {
      stockMap.set(keyOf(s.branchCode, s.skuNumber), s);
    }

    // 2) ดึงข้อมูล Item Movement จากฐานข้อมูลของคุณ
    //    ปรับชื่อ field/table ให้ตรงกับของจริงในระบบคุณ หากต่างไป
    const q = `
      SELECT
        IM.branchCode,
        IM.skuNumber,
        IM.productName,
        IM.onHandQty,
        IM.backlog,
        IM.safetyStock,
        IM.reorderPoint,
        IM.minQty,
        IM.overStock,
        IM.status
      FROM ItemMovement AS IM
      ${branch ? `WHERE IM.branchCode = @branch` : ""}
    `;
    const req = pool.request();
    if (branch) req.input("branch", sql.VarChar, branch);
    const rs = await req.query(q);

    // 3) ประกอบ rows + ผสานค่า trend/turnOver/sales6 จาก StockStatusService
    const rows = [];
    for (const r of (rs.recordset || [])) {
      const st = stockMap.get(keyOf(r.branchCode, r.skuNumber));

      // ดึงค่าที่ต้องเหมือน Stock Status
      const turnOver = st?.turnOver ?? null;
      const trend    = st?.trend    ?? null;     // <-- เอามาจาก StockStatusService โดยตรง
      const sales6   = Array.isArray(st?.sales6) ? st.sales6 : []; // สำหรับ popup ยอดขายย้อนหลัง (ถ้าหน้าเว็บใช้)

      // (ถ้าต้องการ averageDemand ให้เหมือน Stock Status ด้วย สามารถใช้ st?.averageDemand ได้)
      // แต่คงค่าจากฝั่ง ItemMovement ที่มีอยู่เดิมไว้ก่อน เว้นแต่คุณอยากแทนที่ให้ตรงกันทุกจุด
      rows.push({
        branchCode   : r.branchCode,
        skuNumber    : r.skuNumber,
        productName  : r.productName,
        safetyStock  : r.safetyStock,
        reorderPoint : r.reorderPoint,
        minQty       : r.minQty,
        onHandQty    : r.onHandQty,
        backlog      : r.backlog,
        overStock    : r.overStock,
        status       : r.status,

        // มาจาก StockStatusService
        turnOver,
        trend,
        sales6,
      });
    }

    // 4) จัดการ sort (รองรับ trend ให้เรียงได้)
    const sortKeyMap = {
      branchCode   : "branchCode",
      skuNumber    : "skuNumber",
      productName  : "productName",
      onHandQty    : "onHandQty",
      backlog      : "backlog",
      overStock    : "overStock",
      minQty       : "minQty",
      safetyStock  : "safetyStock",
      reorderPoint : "reorderPoint",
      turnOver     : "turnOver",
      trend        : "trend",          // ✅ เพิ่มคีย์ trend
      status       : "status",
    };

    const sortBy = sortKeyMap[opts.sortBy] || "branchCode";

    rows.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];

      // เรียงเลข/ไม่ใช่เลขให้สมเหตุสมผล
      const aNum = typeof av === "number" ? av : (av == null ? NaN : Number(av));
      const bNum = typeof bv === "number" ? bv : (bv == null ? NaN : Number(bv));

      let cmp;
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
        cmp = aNum - bNum;
      } else {
        cmp = String(av ?? "").localeCompare(String(bv ?? ""), "th", { sensitivity: "base" });
      }
      return order === "desc" ? -cmp : cmp;
    });

    // ถ้าคุณมี convention ให้ Route ห่อเป็น { rows } ก็ return เป็น object ได้
    // ที่นี่คง return array ให้เหมือนโค้ดเดิมของคุณ
    return rows;
  }
}
