This changelog summarizes all changes of the RAG Web Browser

### 1.0.15 (2025-03-27)

🐛 Bug Fixes
- Cancel requests only in standby mode

### 1.0.13 (2025-03-27)

🐛 Bug Fixes
- Cancel crawling requests from timed-out search queries

### 1.0.12 (2025-03-24)

🐛 Bug Fixes
- Updated selector for organic search results and places

### 1.0.11 (2025-03-21)

🐛 Bug Fixes
- Selector for organic search results

### 1.0.10 (2025-03-19)

🚀 Features
- Handle all query parameters in the standby mode (including proxy)

### 1.0.9 (2025-03-14)

🚀 Features
- Change default value for `scrapingTool` from 'browser-playwright' to 'raw-http' to improve latency.

### 1.0.8 (2025-03-07)

🚀 Features
- Add a new `scrapingTool` input to allow users to choose between Browser scraper and raw HTTP scraper

### 1.0.7 (2025-02-20)

🚀 Features
- Update Readme.md to include information about MCP

### 1.0.6 (2025-02-04)

🚀 Features
- Handle double encoding of URLs

### 1.0.5 (2025-01-17)

🐛 Bug Fixes
- Change default value of input query
- Retry search if no results are found

### 1.0.4 (2025-01-04)

🚀 Features
- Include Model Context Protocol in Standby Mode

### 1.0.3 (2024-11-13)

🚀 Features
- Improve README.md and simplify configuration
- Add an AWS Lambda function
- Hide variables initialConcurrency, minConcurrency, and maxConcurrency in the Actor input and remove them from README.md
- Remove requestTimeoutContentCrawlSecs and use only requestTimeoutSecs
- Ensure there is enough time left to wait for dynamic content before the Actor timeout (normal mode)
- Rename googleSearchResults to searchResults and searchProxyGroup to serpProxyGroup
- Implement input validation

### 0.1.4 (2024-11-08)

🚀 Features
- Add functionality to extract content from a specific URL
- Update README.md to include new functionality and provide examples

### 0.0.32 (2024-10-17)

🚀 Features
- Handle errors when request is added to Playwright queue.
  This will prevent the Cheerio crawler from repeating the same request multiple times.
- Silence error: Could not parse CSS stylesheet as there is no way to fix it at our end
- Set logLevel to INFO (debug level can be set using the `debugMode=true` input)

### 2024-10-11

🚀 Features
- Increase the maximum number of results (`maxResults`) from 50 to 100
- Explain better how to search a specific website using "llm site:apify.com"

### 2024-10-07

🚀 Features
- Add a short description how to create a custom action

### 2024-09-24

🚀 Features
- Updated README.md to include tips on improving latency
- Set initialConcurrency to 5
- Set minConcurrency to 3

### 2024-09-20

🐛 Bug Fixes
- Fix response format when crawler fails

### 2024-09-24

🚀 Features
- Add ability to create new crawlers using query parameters
- Update Dockerfile to node version 22

🐛 Bug Fixes
- Fix playwright key creation

### 2024-09-11

🚀 Features
- Initial version of the RAG Web Browser
