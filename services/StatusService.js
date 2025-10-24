// services/StatusService.js

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * คำนวณสถานะตาม flowchart
 * @param {object} p
 * @param {boolean} p.isNewItem     - เป็นสินค้าใหม่หรือไม่
 * @param {boolean} p.inItemGroup   - อยู่ในกลุ่มสินค้าที่ต้องพิจารณาหรือไม่
 * @param {number}  p.frequency6    - ความถี่การขาย 6 เดือนล่าสุด (เดือนที่มียอด > 0)
 * @param {number}  p.salesLast1    - ยอดขาย "เดือนปัจจุบัน" (คอลัมน์เดือนล่าสุด)
 * @param {number}  p.avg           - Average Demand
 * @param {number}  p.onHandQty     - จำนวนคงเหลือ (Stock)
 * @param {number}  p.outstandingPo - PO_ค้าง (Backlog)
 * @param {number}  p.minQty        - MIN (เช่น safetyStock + reorderPoint)
 * @returns {"ไม่ต้องสั่งซื้อ" | "มากเกินไป" | "สั่งซื้อ"}
 */
export function determineStatus(p) {
  const isNewItem     = !!p.isNewItem;
  const inItemGroup   = !!p.inItemGroup;
  const frequency6    = n(p.frequency6);
  const salesLast1    = n(p.salesLast1);   // เดือนปัจจุบัน
  const avg           = n(p.avg);
  const onHand        = n(p.onHandQty);
  const outstandingPo = n(p.outstandingPo);
  const minQty        = Math.max(0, Math.ceil(n(p.minQty)));

  // ไม่ต้องสั่งซื้อ
  const noOrder =
    ((!isNewItem && frequency6 <= 1 && salesLast1 <= 0) || // ใช้ <= 0     
    inItemGroup ||
     (avg == 0 && onHand == 0));

  if (noOrder) return "ไม่ต้องสั่งซื้อ";

  // มากเกินไป
  if (onHand + outstandingPo > minQty) return "มากเกินไป";

  // สั่งซื้อ
  return "น้อยเกินไป";
}
