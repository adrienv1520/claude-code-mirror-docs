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
const TELEGRAM_PUBLIC_CHANNEL_URL = 'https://t.me/+KFW99jUnwOA1ODA8';

// --- Utility Functions ---
const slugify = (text) => text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

/**
 * Removes previously generated files and directories to ensure a clean build.
 */
async function cleanPreviousBuild() {
  console.log('🧼 1. Cleaning up previous build...');

  await fs.rm(DOCS_DIR, { recursive: true, force: true });
  console.log(`   -> Directory '${DOCS_DIR}' removed.`);

  await fs.rm(ROOT_README_PATH, { force: true });
  console.log(`   -> File '${ROOT_README_PATH}' removed.`);

  await fs.mkdir(DOCS_DIR, { recursive: true });
  console.log('   Cleanup complete.');
}

/**
 * Fetches all URLs from the site's sitemap and filters for the target documentation.
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
 * Scrapes the navigation page to extract its structure and create a
 * slug-to-category map for link rewriting.
 */
async function fetchNavigationStructure() {
  console.log('⛵ 3. Analyzing navigation structure and creating link map...');
  const response = await axios.get(NAV_PAGE_URL);
  const $ = cheerio.load(response.data);
  const structure = [];
  const slugToCategoryMap = new Map();

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
        slugToCategoryMap.set(fileSlug, categorySlug);
      }
    });
    structure.push(category);
  });

  console.log(`   Structure extracted with ${structure.length} categories.`);
  return { structure, slugToCategoryMap };
}

/**
 * Rewrites absolute documentation links within the downloaded Markdown content
 * to relative local file links.
 */
function rewriteLocalLinks(content, currentCategorySlug, slugToCategoryMap, filePath) {
  // This regex finds Markdown links pointing to the Claude Code docs.
  const linkRegex = /\]\(((\/en\/docs\/claude-code\/([^"#)]+))(#?[^")]*)?)\)/g;

  return content.replaceAll(linkRegex, (match, fullUrl, fullPath, targetSlug, fragment) => {
    const targetCategorySlug = slugToCategoryMap.get(targetSlug);
    const safeFragment = fragment || '';

    if (!targetCategorySlug) {
      console.warn(`   ! Could not find category for link target: '${targetSlug}' in file '${filePath}'. Skipping rewrite.`);
      return match;
    }

    const fromDir = path.join(DOCS_DIR, currentCategorySlug);
    const toFile = path.join(DOCS_DIR, targetCategorySlug, `${targetSlug}.md`);
    const relativePath = path.relative(fromDir, toFile);

    // Reconstruct the Markdown link with the new relative path.
    return `](${relativePath}${safeFragment})`;
  });
}

/**
 * Downloads each document, rewrites its internal links to be relative,
 * and saves it to the correct directory based on the site structure.
 */
async function downloadAndSaveDocs(allUrls, navStructure, slugToCategoryMap) {
  console.log('📖 4. Downloading, rewriting, and saving documentation...');
  const downloadPromises = [];
  const otherFiles = [];

  for (const url of allUrls) {
    const urlMdFile = `${url}.md`;
    const fileSlug = path.basename(url);
    const categorySlug = slugToCategoryMap.get(fileSlug) || 'others';

    if (categorySlug === 'others' && !otherFiles.some((f) => f.slug === fileSlug)) {
      otherFiles.push({ slug: fileSlug, title: fileSlug });
    }

    const dirPath = path.join(DOCS_DIR, categorySlug);
    const filePath = path.join(dirPath, `${fileSlug}.md`);

    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(dirPath, { recursive: true });

    downloadPromises.push(
      axios.get(urlMdFile, { responseType: 'text' })
        .then((response) => {
          console.log(`   -> Processing ${filePath}`);
          // eslint-disable-next-line max-len
          const rewrittenContent = rewriteLocalLinks(response.data, categorySlug, slugToCategoryMap, filePath);
          return fs.writeFile(filePath, rewrittenContent, 'utf-8');
        })
        .catch((err) => console.error(`   ! Failed to process ${urlMdFile}: ${err.message}`)),
    );
  }

  await Promise.all(downloadPromises);
  console.log('   File processing complete.');
  return { otherFiles };
}

/**
 * Generates a root README.md file with a complete table of contents
 * linking to all the mirrored documentation files.
 */
async function generateReadme(navStructure, otherFiles) {
  console.log('👓 5. Generating root README.md...');
  let readmeContent = '# Claude Code Mirror Docs\n\n';
  readmeContent += '_This repository is a mirror of the official [Claude Code](https://docs.anthropic.com/en/docs/claude-code/) documentation. It is updated automatically._\n\n';
  readmeContent += `**Last updated:** ${new Date().toUTCString()}\n\n`;
  readmeContent += '<details>\n';
  readmeContent += '<summary><strong>🔔 Stay Updated (Get Notified of Changes)</strong></summary>\n\n';
  readmeContent += '> **1. GitHub Releases (Recommended)**\n';
  readmeContent += '> Click the `Watch` button at the top-right of this page, then select `Custom` > `Releases`. You will receive a notification from GitHub whenever a new version is published.\n\n';
  readmeContent += '> **2. Telegram Channel**\n';
  readmeContent += '> Join our public Telegram channel for instant notifications.\n';
  readmeContent += `> **➡️ [Subscribe on Telegram](${TELEGRAM_PUBLIC_CHANNEL_URL})**\n`;
  readmeContent += '</details>\n\n';
  readmeContent += '---\n\n';

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
 * The main function that orchestrates the entire mirroring process.
 */
async function main() {
  await cleanPreviousBuild();
  const allUrls = await fetchAllUrlsFromSitemap();
  const { structure, slugToCategoryMap } = await fetchNavigationStructure();
  const { otherFiles } = await downloadAndSaveDocs(allUrls, structure, slugToCategoryMap);
  await generateReadme(structure, otherFiles);
  console.log('\n✅ Update process completed successfully!');
}

main().catch((error) => {
  console.error('\n❌ A fatal error occurred during the process:', error);
  process.exit(1);
});
