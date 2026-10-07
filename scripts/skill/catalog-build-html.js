'use strict';

/**
 * catalog-build-html.js
 * Inlines delivery-graph JSON data into the dashboard HTML template to produce
 * a standalone, zero-dependency, portable HTML visualization.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/dashboard/index.html');

/**
 * Build standalone dashboard HTML file from delivery graph data and HTML template.
 *
 * @param {object} options
 * @param {object|string} options.graphData - Delivery graph object or JSON string
 * @param {string} [options.templatePath] - Path to HTML template
 * @param {string} [options.outputPath] - Output HTML file path
 * @returns {string} The full rendered HTML content
 */
function buildDashboardHtml(options = {}) {
  const {
    graphData,
    templatePath = DEFAULT_TEMPLATE_PATH,
    outputPath
  } = options;

  if (!graphData) {
    throw new Error('buildDashboardHtml requires graphData object or JSON string');
  }

  const jsonStr = typeof graphData === 'string' ? graphData : JSON.stringify(graphData, null, 2);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Dashboard template file not found at: ${templatePath}`);
  }

  const templateContent = fs.readFileSync(templatePath, 'utf8');

  // Escape any premature closing script tags within JSON strings
  const safeJsonStr = jsonStr.replace(/<\/script/gi, '<\\/script');

  // Use a replacer function to prevent String.prototype.replace from interpreting `$` characters
  let html = templateContent.replace('{{DELIVERY_DATA_JSON}}', () => safeJsonStr);

  if (outputPath) {
    const outputDir = path.dirname(path.resolve(outputPath));
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, html, 'utf8');
  }

  return html;
}

// CLI Support
if (require.main === module) {
  const args = process.argv.slice(2);
  let jsonPath = '';
  let templatePath = DEFAULT_TEMPLATE_PATH;
  let outputPath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && args[i + 1]) {
      jsonPath = args[++i];
    } else if (args[i] === '--template' && args[i + 1]) {
      templatePath = args[++i];
    } else if ((args[i] === '--output' || args[i] === '--html') && args[i + 1]) {
      outputPath = args[++i];
    }
  }

  if (!jsonPath || !outputPath) {
    console.error('Usage: node scripts/skill/catalog-build-html.js --json <path> --output <path> [--template <path>]');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const graphData = JSON.parse(raw);
    buildDashboardHtml({ graphData, templatePath, outputPath });
    console.log(`Successfully built dashboard HTML: ${outputPath}`);
  } catch (err) {
    console.error(`Error building dashboard HTML: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildDashboardHtml,
  DEFAULT_TEMPLATE_PATH
};
