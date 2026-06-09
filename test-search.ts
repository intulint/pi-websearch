/**
 * Test script for DuckDuckGo search
 * Usage: npx tsx test-search.ts "search query" [limit]
 */

import https from "node:https";
import zlib from "node:zlib";

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

async function searchDdg(query: string, limit: number = 5): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}&b=0&p=1&s=0&df=y`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
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
    'sec-ch-ua': '"Chromium";v="146", "Not=A?Brand";v="8"',
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
        
        // Parse results from HTML
        // Use lookahead to capture full result divs including inner content
        const resultBlocks = html.match(/<div class="result[^"]*results_links[^"]*"[^>]*>[\s\S]*?(?=<div class="result[^"]*results_links|$)/g);
        const results: SearchResult[] = [];
        
        if (resultBlocks) {
          for (let i = 0; i < Math.min(limit, resultBlocks.length); i++) {
            const block = resultBlocks[i];
            
            // Extract title from h2.result__title > a.result__a
            const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
            
            if (!title) continue;
            
            // Extract URL from result__a anchor
            const urlMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"/);
            let url = urlMatch?.[1] || '';
            
            // Decode DuckDuckGo redirect URL
            if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
              url = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
            } else if (url.startsWith('//')) {
              url = 'https:' + url;
            }
            
            if (!url) continue;
            
            // Extract description from a.result__snippet
            const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
            const description = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
            
            results.push({
              title,
              url,
              description,
            });
          }
        }
        
        resolve(results);
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
    const results = await searchDdg(query, limit);
    console.log(`✅ Found ${results.length} results:\n`);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
