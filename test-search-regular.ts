/**
 * Test script for regular DuckDuckGo search (not HTML version)
 * Usage: npx tsx test-search-regular.ts "search query" [limit]
 */

import https from "node:https";
import zlib from "node:zlib";

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

async function searchDdgRegular(query: string, limit: number = 5): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://duckduckgo.com/?q=${encodedQuery}&b=0&p=1&s=0&df=y`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-GPC': '1',
    'Cache-Control': 'max-age=0',
    'sec-ch-ua': '"Chromium";v="129", "Not=A?Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');
        
        // Decode compressed content
        if (res.headers['content-encoding'] === 'gzip') {
          html = zlib.gunzipSync(Buffer.concat(chunks)).toString('utf-8');
        } else if (res.headers['content-encoding'] === 'br') {
          html = zlib.brotliDecompressSync(Buffer.concat(chunks)).toString('utf-8');
        }
        
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: Failed to fetch search results`));
          return;
        }
        
        // Check for challenge page (bot detection)
        if (html.includes('challenge-form')) {
          reject(new Error('DuckDuckGo detected an anomaly in the request. Please try again later.'));
          return;
        }
        
        // TODO: Parse results from HTML
        // The regular DuckDuckGo page uses JavaScript to load results dynamically
        // We need to find the correct selectors for the results
        
        console.log('📄 HTML length:', html.length);
        console.log('💡 Note: Regular DuckDuckGo loads results via JavaScript');
        console.log('💡 Consider using html.duckduckgo.com for static HTML parsing');
        
        resolve([]);
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Main
async function main() {
  const query = process.argv[2] || 'последние новости AI';
  const limit = parseInt(process.argv[3] || '5');
  
  console.log(`\n🔍 Searching for: "${query}"`);
  console.log(`📊 Limit: ${limit}\n`);
  
  try {
    const results = await searchDdgRegular(query, limit);
    console.log(`✅ Found ${results.length} results:\n`);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
