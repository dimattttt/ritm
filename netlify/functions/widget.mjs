// Netlify: GET /api/widget — сводка на сегодня для виджета iPhone (Scriptable, public/ritm-widget.js).
// Логика и тесты — netlify/lib/widget-handler.mjs, netlify/lib/widget-data.mjs.
import { handleWidget } from "../lib/widget-handler.mjs";

export default (req) => handleWidget(req);

export const config = { path: "/api/widget", method: ["GET", "OPTIONS"] };
