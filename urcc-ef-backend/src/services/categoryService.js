/**
 * Canonical institution categories, read from the `categories` table that
 * scripts/db_builder.py writes from scripts/categories.py (single source of
 * truth for ids, labels and aliases). Every category string that enters the
 * API - upload form, bank registration, chat filter - goes through
 * normalise(), so "commercial banks", "commercial_banks", "CB" and
 * "Commercial Banks" all mean the same thing and an unknown value is
 * rejected instead of silently creating a new category.
 */
const db = require("../config/db");

let cached = null;

function key(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function all() {
  if (cached) return cached;
  let rows = [];
  try {
    rows = db.prepare("SELECT category_id, label, slug, aliases FROM categories ORDER BY sort_order").all();
  } catch (_) {
    rows = [];
  }
  cached = rows.map((r) => ({ id: r.category_id, label: r.label, slug: r.slug, aliases: JSON.parse(r.aliases || "[]") }));
  return cached;
}

function normalise(value) {
  if (!value) return null;
  const k = key(value);
  for (const c of all()) {
    if (key(c.id) === k || key(c.label) === k || key(c.slug) === k || c.aliases.some((a) => key(a) === k)) return c.id;
  }
  return null;
}

function label(id) {
  return all().find((c) => c.id === id)?.label || id;
}

function reset() {
  cached = null;
}

module.exports = { all, normalise, label, reset };
