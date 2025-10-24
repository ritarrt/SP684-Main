export class MonthWindow {
  constructor(allMonthCols) {
    this.all = [...allMonthCols]; // เช่น ["Jan_67",...,"Jul_68"]
  }

  /**
   * เลือกคอลัมน์เดือน N เดือนย้อนหลัง
   * @param {number} months - จำนวนเดือนย้อนหลัง (3/6/12)
   * @param {boolean} excludeCurrent - true = ตัดเดือนล่าสุดออก (ไม่รวมเดือนปัจจุบัน)
   */
  pick(months = 6, excludeCurrent = true) {
    if (!Array.isArray(this.all) || this.all.length === 0) return [];
    if (excludeCurrent) {
      const tail = this.all.slice(-(months + 1)); // เอา N+1 ตัวท้าย
      return tail.slice(0, -1);                   // ตัดตัวท้ายสุด (เดือนปัจจุบัน)
    }
    return this.all.slice(-months);
  }

  /**
   * นิพจน์ SUM แบบกัน overflow (BIGINT) และกัน NULL
   */
  buildSumExpr(cols) {
    if (!cols.length) return "CAST(0 AS BIGINT)";
    return cols.map(c => `CAST(ISNULL([${c}],0) AS BIGINT)`).join(" + ");
  }

  /**
   * นิพจน์ตัวนับเดือน:
   *  - mode = 'all'      → นับทุกเดือนที่เลือก (รวมศูนย์)
   *  - mode = 'nonzero'  → นับเฉพาะเดือนที่ > 0
   */
  buildCountExpr(cols, mode = "nonzero") {
    if (!cols.length) return "0";
    if (mode === "all") return String(cols.length);
    return cols
      .map(c => `(CASE WHEN CAST(ISNULL([${c}],0) AS INT) > 0 THEN 1 ELSE 0 END)`)
      .join(" + ");
  }
}
