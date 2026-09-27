// Stand-in for the native `sharp` image library (see package.json).
function sharp() {
  throw new Error("Image processing is not available: sharp is stubbed out (text embeddings only).");
}
module.exports = sharp;
module.exports.default = sharp;
