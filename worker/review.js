// Reviewed 2026-10-21. No words from the blocked list appear here (ids and hashes only).
// BLOCKED_ART: design files whose current artwork shows blocked text. Any product using one of these
// files is hidden. When the artwork is replaced (new upload => new file id/hash) the product shows again.
export const BLOCKED_ART = [
 "pf:4a82b8d65319bdab2f5501a10432d7ac",
 "pf:4ffc3a1f75eea107688848ecf0d3fed4",
 "pf:518fc9c5578ac947ce1587979207d431",
 "pf:8a7e7687e247b9e8487a97a6aae389f8",
 "pf:9dc805a6f4be3c29861b68167b209873",
 "pf:dcb66d12c72e39934249685f44c6dc77",
 "pf:id1032228723",
 "pf:id1037940654",
 "pfy:6a6f21e980e070d78762ba15",
 "pfy:6aa257cc5cecb69d42150ed7",
 "pfy:6aa25e4fecba32000befb634",
 "pfy:6aa265c1d8f9cac51369dd7c",
 "pfy:bb74e505-ebdc-3da0-1e3f-4925e7fbd8f9",
 "pfy:d3236a32-06ad-730c-4701-ea7f1dbf1abe"
];
// Display titles, keyed by sha256(provider title).slice(0,16): only used while the provider title is unchanged.
export const TITLE_OVERRIDES = {
 "b4051744ae719906": "Monarch of the Moon Ceramic Mug",
 "b5c1fa59b6d16f84": "Gothic Celestial Wall Tapestry",
 "0f9abecfde165709": "Gothic Celestial Wall Tapestry",
 "eb81435554e8ebc7": "The Self-Made Tarot Card Sticker",
 "edc250940773dd19": "Celestial Wall Tapestry",
 "68e89f50d660a19e": "The Self-Made III Woven Blanket",
 "816a1e73ca2b1d6b": "Red & White Satin Poster",
 "b9fbb46c586b62aa": "Celestial Wisdom Hardcover Journal",
 "75f590b031a4990b": "Copper Insulated Cup",
 "142e8c3e2bbf1dd9": "Copper Insulated Cup",
 "ae5b5ec64b19af0a": "Monarch of the Moon Organic Tote Bag",
 "b77dce1a9342f02b": "Monarch of the Moon Cotton Bodycon Dress",
 "914c48298d239367": "Monarch of the Moon Can Cooler",
 "21e6a9c813fa3fad": "Nocturnal Owl Sticker",
 "ca6a0bcf92c379fe": "Celestial Clear iPhone Case",
 "26170e85d22c7afb": "Celestial Clear iPhone Case",
 "9a459fdb437c8e03": "Monarch of the Moon Cotton Bodycon Dress",
 "1af6a2084a25aba8": "Monarch of the Moon Tarot Card Gothic Celestial Wall Tapestry"
};
// Owner-approved 2026-10-21: these products show even though their artwork is on the review list.
// The approval covers exactly these design files; if the product's artwork changes, the normal rules apply again.
export const APPROVED_ART = {
 "pfy-6ad7ef1ca213b61c990d89fa": ["pfy:6aa265c1d8f9cac51369dd7c", "pfy:6aa26650496a79fdb337cb22"],
 "pfy-6ad7ef1aa213b61c990d89f6": ["pfy:6aa27687e0707a4612dc1304"]
};

// Owner-hidden products (pricing/other reasons, not artwork). Remove an id to show it again.
export const HIDDEN_PRODUCTS = {
 "pfy-6ad7ef1ba213b61c990d89f7": "The Self-Made III Woven Blanket: sells at a loss until the price is raised"
};
