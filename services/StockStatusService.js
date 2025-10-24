import { determineStatus } from "./StatusService.js";
import jstatPkg from "jstat";
import { getPool } from "../db.js";
import { MonthWindow } from "../lib/MonthWindow.js";

export class StockStatusService {
    constructor() {
        this.MONTH_COLS = [
            "Jan_67", "Feb_67", "Mar_67", "Apr_67", "May_67", "Jun_67",
            "Jul_67", "Aug_67", "Sep_67", "Oct_67", "Nov_67", "Dec_67",
            "Jan_68", "Feb_68", "Mar_68", "Apr_68", "May_68", "Jun_68", "Jul_68"
        ];
        this.window = new MonthWindow(this.MONTH_COLS);
    }

    async getStockStatus(opts = {}) {
        const months = [3, 6, 12].includes(Number(opts.months)) ? Number(opts.months) : 6;
        const excludeCurrent = (String(opts.excludeCurrent ?? "true").toLowerCase() !== "false");
        const branch = String(opts.branch || "").trim();

        const colsAvg = this.window.pick(months, excludeCurrent);
        const colsStdev6 = this.window.pick(6, true);

        // เลือกคอลัมน์ยอดขาย 6 เดือน (ใช้ชื่อคอลัมน์เดิม ๆ ในตาราง)
        const salesColsSelect = colsStdev6
        .map(c => `ISNULL(t.[${c}],0) AS [${c}]`)
        .join(", ");

        if (!colsAvg.length || !colsStdev6.length) {
            return { monthsUsed: months, excludeCurrent, count: 0, rows: [] };
        }

        const currentMonthCol = this.MONTH_COLS[this.MONTH_COLS.length - 1];
        const sumExpr = this.window.buildSumExpr(colsAvg);
        const cntExpr = String(colsAvg.length);

        const valuesStdev6 = colsStdev6.map(c => `(CAST(ISNULL(t.[${c}],0) AS FLOAT))`).join(",");
        const stdevExpr = `(SELECT STDEV(x) FROM (VALUES ${valuesStdev6}) AS _m(x))`;

        const freqExpr = colsStdev6
            .map(c => `(CASE WHEN CAST(ISNULL(t.[${c}],0) AS INT) > 0 THEN 1 ELSE 0 END)`)
            .join(" + ");

        const whereParts = [`ISNULL(LTRIM(RTRIM(t.Item_Code)),'') <> ''`];
        if (branch) whereParts.push(`t.Branch_Code = @branch`);
        const where = `WHERE ${whereParts.join(" AND ")}`;

        const sqlText = `
    SELECT
      t.Branch_Code AS branchCode,
      t.Item_Code   AS skuNumber,
      t.Item_name   AS productName,

      ISNULL(t.LT_PO, 0) AS LT_PO,
      ISNULL(t.LT_Sup, 0) AS LT_SP,
      ISNULL(t.LT_DC, 0) AS LT_DC,

      ISNULL(t.[จำนวนคงเหลือ], 0) AS onHandQty,
      ISNULL(t.[PO_ค้าง], 0)       AS backlog,

      ISNULL(t.[${currentMonthCol}], 0) AS salesLast1,

      ISNULL(t.Item_Group, '') AS Item_Group,
      ISNULL(t.New_Item, 0)    AS New_Item,

      (${sumExpr}) AS sumMonths,
      (${cntExpr}) AS cntMonths,
      CAST(ISNULL(CEILING(
        CAST((${sumExpr}) AS DECIMAL(18,4)) /
        NULLIF(CAST((${cntExpr}) AS DECIMAL(18,4)), 0)
      ), 0) AS INT) AS averageDemand,

      ${stdevExpr} AS stdev6,
      (${freqExpr}) AS frequency6,
      ${salesColsSelect},

      -- === BRAND (กฎเป๊ะ: ตัวแรก E แล้วอ่านตัวที่ 2-3-4 เท่านั้น) ===
      CASE
        WHEN LEFT(LTRIM(RTRIM(t.Item_Code)), 1) = 'E'
             THEN ab.BRAND_NAME
        ELSE NULL
      END AS brandName,

       -- === GROUP (ตัวแรกเป็น E และใช้ตำแหน่งที่ 5-6) ===
  CASE
    WHEN LEFT(LTRIM(RTRIM(t.Item_Code)), 1) = 'E'
         AND LEN(LTRIM(RTRIM(t.Item_Code))) >= 6
      THEN SUBSTRING(LTRIM(RTRIM(t.Item_Code)), 5, 2)
    ELSE NULL
  END AS accGroupId,
  ag.GroupName AS accGroupName

    FROM dbo.TestAll AS t

    -- === JOIN Brand (เดิม) ===
LEFT JOIN dbo.Accessory_BRAND AS ab
  ON ab.BRAND_NO = TRY_CONVERT(int, SUBSTRING(LTRIM(RTRIM(t.Item_Code)), 2, 3))

-- === JOIN Group (ใหม่) ===
LEFT JOIN dbo.Accessory_GROUP AS ag
  ON ag.Group_ID = RIGHT('0' + LTRIM(RTRIM(SUBSTRING(LTRIM(RTRIM(t.Item_Code)), 5, 2))), 2)

    ${where}
    `;

        const pool = await getPool();
        const request = pool.request();
        if (branch && pool.sql?.VarChar) request.input("branch", pool.sql.VarChar(32), branch);
        else if (branch) request.input("branch", branch);

        const result = await request.query(sqlText);

        const rows = result.recordset.map(r => {
            const f = Number(r.frequency6 ?? 0);

            let serviceLevel;
            if (f > 4) serviceLevel = 0.95;
            else if (f > 2 && f <= 4) serviceLevel = 0.93;
            else serviceLevel = 0.50;

            const zRaw = jstatPkg.jStat.normal.inv(serviceLevel, 0, 1);
            const z    = Math.round(zRaw * 100) / 100;
// 0 50 95 99
            const stdevRaw = Number(r.stdev6 ?? 0);
            const stdevInt = Math.round(stdevRaw);

            const ltDays = Math.max(0, Number(r.LT_PO ?? 0) + Number(r.LT_SP ?? 0) + Number(r.LT_DC ?? 0));
            const ltFactor = Math.sqrt(ltDays / 30);
            const sumLT = ltDays / 30;

            const safetyStock   = Math.round(Math.max(0, z * stdevInt * ltFactor));
            const avg           = Number(r.averageDemand ?? 0);
            const reorderPoint  = Math.round(Math.max(0, avg * sumLT));
            const minQty        = Math.max(0, safetyStock + reorderPoint);

            const onHandQty = Math.round(Number(r.onHandQty ?? 0));
            const backlog   = Math.round(Number(r.backlog ?? 0));
            const turnOver  = avg > 0 ? Number(((onHandQty + backlog) / avg).toFixed(2)) : 0;
            const isNewItem =
                Number(r.New_Item) === 1 ||
                String(r.New_Item ?? "").trim().toUpperCase() === "Y";
            const inItemGroup = String(r.Item_Group ?? "").trim() !== "";

            const status = determineStatus({
                isNewItem,
                inItemGroup,
                frequency6: Number(r.frequency6 ?? 0),
                salesLast1: Number(r.salesLast1 ?? 0),
                avg: Number(r.averageDemand ?? 0),
                onHandQty,
                outstandingPo: backlog,
                minQty,
            });

            const sales6 = colsStdev6.map(m => ({
                    month: m,
                    qty: Number(r[m] ?? 0)
                    }));


            // ลำดับยอดขาย 6 เดือนตามคอลัมน์จริง (ตัวเลขล้วน)
            const seq6 = colsStdev6.map(m => Number(r[m] ?? 0));

            // Average of Growth Ratios = average( x_i / x_{i-1} ) สำหรับคู่ที่ตัวหาร > 0
            let sumRat = 0, cntRat = 0;
            for (let i = 1; i < seq6.length; i++) {
            const prev = seq6[i - 1];
            const curr = seq6[i];
            if (prev > 0) {          // ข้ามคู่ที่ตัวหารเป็น 0
                sumRat += (curr / prev);
            }
            cntRat++;
            }
            const growthAvg = cntRat > 0 ? (sumRat / cntRat) : 0;

            // ใช้ค่า growthAvg เป็น Reorder Point (ปัดเป็นจำนวนเต็ม)
            const trend  = Math.round(growthAvg * 100) / 100;

            return {
                branchCode: r.branchCode,
                skuNumber: r.skuNumber,
                productName: r.productName,

                averageDemand: r.averageDemand ?? 0,
                stdev6: stdevInt,
                zScore: z,
                frequency6: f,
                serviceLevel,

                LT_PO: Number(r.LT_PO ?? 0),
                LT_SP: Number(r.LT_SP ?? 0),
                LT_DC: Number(r.LT_DC ?? 0),
                safetyStock,
                trend,
                minQty,
                onHandQty,
                backlog,
                turnOver,
                Item_Group: r.Item_Group,
                New_Item: r.New_Item,
                status,
                brandName: r.brandName ?? null,

                accGroupId: r.accGroupId ?? null,
                accGroupName: r.accGroupName ?? null,
                sales6
            };
        });

        // sorting
        const sortKeyMap = {
            branchCode:   'branchCode',
            skuNumber:    'skuNumber',
            productName:  'productName',
            averageDemand:'averageDemand',
            safetyStock:  'safetyStock',
            trend: 'trend',
            min:          'minQty',
            minQty:       'minQty',
            onhand:       'onHandQty',
            onHandQty:    'onHandQty',
            backorder:    'backlog',
            backlog:      'backlog',
            turnover:     'turnOver',
            turnOver:     'turnOver',
            brand:        'brandName',
            brandName:    'brandName',
            accGroupId:   'accGroupId',
            accGroupName: 'accGroupName',

        };

        const sortByParam = String(opts.sortBy || '').trim();
        const orderParam  = String(opts.order  || 'asc').toLowerCase();

        const sortKey = sortKeyMap[sortByParam] || null;
        const sortDir = (orderParam === 'desc') ? -1 : 1;

        function cmp(a, b) {
            const ax = a ?? null;
            const bx = b ?? null;
            if (ax === null && bx === null) return 0;
            if (ax === null) return  1;
            if (bx === null) return -1;
            if (typeof ax === 'number' && typeof bx === 'number') {
                if (Number.isNaN(ax) && Number.isNaN(bx)) return 0;
                if (Number.isNaN(ax)) return 1;
                if (Number.isNaN(bx)) return -1;
                return ax < bx ? -1 : (ax > bx ? 1 : 0);
            }
            return String(ax).localeCompare(String(bx), undefined, { sensitivity: 'accent', numeric: true });
        }

        if (sortKey) rows.sort((r1, r2) => sortDir * cmp(r1[sortKey], r2[sortKey]));

        return {
            monthsUsed: months,
            excludeCurrent,
            stdevMonths: 6,
            frequencyMonths: 6,
            count: rows.length,
            rows
        };
    }
}
