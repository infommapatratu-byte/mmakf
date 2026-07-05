// Stops PostCSS config resolution at the project root — without this, Vite
// walks up into the Downloads folder and loads an unrelated postcss.config.js.
module.exports = { plugins: [] };
