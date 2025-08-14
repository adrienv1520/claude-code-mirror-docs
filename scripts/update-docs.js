/* eslint-disable no-console, no-restricted-syntax */
import axios from 'axios';
import { Parser } from 'xml2js';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';

// --- Configuration ---
const SITEMAP_URL = 'https://docs.anthropic.com/sitemap.xml';
const NAV_PAGE_URL = 'https://docs.anthropic.com/en/docs/claude-code/overview';
const URL_PREFIX = 'https://docs.anthropic.com/en/docs/claude-code/';
const BASE_URL = 'https://docs.anthropic.com';
const DOCS_DIR = 'docs';
const ROOT_README_PATH = 'README.md';

// --- Utility Functions ---
const slugify = (text) => text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

/**
 * Cleans the output directory and the root README.md file.
 */
async function cleanPreviousBuild() {
  console.log('🧼 1. Cleaning up previous build...');

  // Remove the 'docs' directory
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
  console.log(`   -> Directory '${DOCS_DIR}' removed.`);

  // Remove the root README.md
  await fs.rm(ROOT_README_PATH, { force: true });
  console.log(`   -> File '${ROOT_README_PATH}' removed.`);

  // Recreate the empty 'docs' directory
  await fs.mkdir(DOCS_DIR, { recursive: true });
  console.log('   Cleanup complete.');
}

/**
 * Step 1: Fetch the complete list of URLs from the sitemap.
 */
async function fetchAllUrlsFromSitemap() {
  console.log('🗺️ 2. Fetching all URLs from the sitemap...');
  const response = await axios.get(SITEMAP_URL);
  const parser = new Parser();
  const result = await parser.parseStringPromise(response.data);
  const allUrls = result.urlset.url.map((url) => url.loc[0]);
  const claudeUrls = allUrls.filter((url) => url.startsWith(URL_PREFIX));
  console.log(`   ${claudeUrls.length} Claude Code URLs found.`);
  return claudeUrls;
}

/**
 * Step 2: Scrape the navigation page to extract its structure.
 */
async function fetchNavigationStructure() {
  console.log('⛵️ 3. Analyzing navigation structure...');
  const response = await axios.get(NAV_PAGE_URL);
  const $ = cheerio.load(response.data);
  const structure = [];

  $('#navigation-items > div').each((i, div) => {
    const categoryTitle = $(div).find('h5#sidebar-title').text().trim();
    if (!categoryTitle) return;

    const categorySlug = slugify(categoryTitle);
    const category = {
      title: categoryTitle,
      slug: categorySlug,
      files: [],
    };

    $(div).find('ul#sidebar-group li a').each((j, a) => {
      const href = $(a).attr('href');
      const fileTitle = $(a).text().trim();
      if (href) {
        const fileSlug = path.basename(href);
        category.files.push({ slug: fileSlug, title: fileTitle, href: `${BASE_URL}${href}` });
      }
    });
    structure.push(category);
  });

  console.log(`   Structure extracted with ${structure.length} categories.`);
  return { structure };
}

/**
 * Step 3: Download and save the documents into the correct directory structure.
 */
async function downloadAndSaveDocs(allUrls, navStructure) {
  console.log('📖 4. Downloading and organizing documentation files...');
  const downloadPromises = [];
  const otherFiles = [];

  for (const url of allUrls) {
    const urlMdFile = `${url}.md`;
    let categorySlug = null;
    for (const category of navStructure) {
      if (category.files.some((file) => file.href === url)) {
        categorySlug = category.slug;
        break;
      }
    }

    const fileSlug = path.basename(url);
    if (!categorySlug) {
      categorySlug = 'others'; // Category for uncategorized files
      if (!otherFiles.some((f) => f.slug === fileSlug)) {
        otherFiles.push({ slug: fileSlug, title: fileSlug });
      }
    }

    const dirPath = path.join(DOCS_DIR, categorySlug);
    const filePath = path.join(dirPath, `${fileSlug}.md`);

    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(dirPath, { recursive: true });

    downloadPromises.push(
      axios.get(urlMdFile, { responseType: 'text' })
        .then((response) => fs.writeFile(filePath, response.data, 'utf-8'))
        .then(() => console.log(`   -> ${filePath}`))
        .catch((err) => console.error(`   ! Failed to download ${url}: ${err.message}`)),
    );
  }

  await Promise.all(downloadPromises);
  console.log('   Download complete.');
  return { otherFiles };
}

/**
 * Step 4: Generate a README.md file at the project root with a table of contents.
 */
async function generateReadme(navStructure, otherFiles) {
  console.log('👓 5. Generating root README.md...');
  let readmeContent = '# Claude Code Mirror Docs\n\n';
  readmeContent += '_This repository is a mirror of the official [Claude Code](https://docs.anthropic.com/en/docs/claude-code/) documentation. It is updated automatically._\n\n';
  readmeContent += `**Last updated:** ${new Date().toUTCString()}\n\n---\n\n`;

  for (const category of navStructure) {
    readmeContent += `## ${category.title}\n\n`;
    for (const file of category.files) {
      readmeContent += `- [${file.title}](./${DOCS_DIR}/${category.slug}/${file.slug}.md)\n`;
    }
    readmeContent += '\n';
  }

  if (otherFiles.length > 0) {
    readmeContent += '## Others\n\n';
    for (const file of otherFiles) {
      readmeContent += `- [${file.title}](./${DOCS_DIR}/others/${file.slug}.md)\n`;
    }
    readmeContent += '\n';
  }

  await fs.writeFile(ROOT_README_PATH, readmeContent);
  console.log('   README.md successfully generated at the project root.');
}

/**
 * Main function to run the script.
 */
async function main() {
  await cleanPreviousBuild();
  const allUrls = await fetchAllUrlsFromSitemap();
  const { structure } = await fetchNavigationStructure();
  const { otherFiles } = await downloadAndSaveDocs(allUrls, structure);
  await generateReadme(structure, otherFiles);
  console.log('\n✅ Update process completed successfully!');
}

main().catch((error) => {
  console.error('\n❌ A fatal error occurred during the process:', error);
  process.exit(1);
});
