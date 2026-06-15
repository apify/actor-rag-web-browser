# URL to Markdown 
Extract content from any URL and convert it into clean Markdown ready for large language models (LLMs). This is ideal for retrieval-augmented generation (RAG) pipelines, AI training data, and knowledge-base ingestion.

## How to use URL to Markdown Converter
This Actor has one compulsory input: a URL you wish to convert.

Additionally, you can select the **Scraping mode**:
- The Raw HTTP mode (default) is the fastest and cheapest, but can't handle JavaScript.
- The Browser mode is more powerful and can handle JavaScript-heavy websites.

It will return an output with the following data:
- URL
- Markdown of the page
- Basic metadata

This Actor doesn't support pagination or crawling to discover new URLs. If you are looking to convert a whole website to Markdown, use the [Website Content Crawler](https://apify.com/apify/website-content-crawler) instead.

### Input example
```json
{
   "url": "https://apify.com",
   "scrapingTool": "raw-http"
}
```
### Output example
```json
[{
  "crawl": {
    "httpStatusCode": 200,
    "httpStatusMessage": "OK",
    "loadedAt": "2026-06-11T09:00:12.010Z",
    "uniqueKey": "I0mexdHttr",
    "requestStatus": "handled"
  },
  "metadata": {
    "title": "Apify: Full-stack web scraping and data extraction platform",
    "description": "Cloud platform for web scraping, browser automation, AI agents, and data for AI. Use 38,000+ ready-made tools, code templates, or order a custom solution.",
    "languageCode": "en",
    "url": "https://apify.com",
    "redirectedUrl": "https://apify.com/"
  },
  "query": "https://apify.com",
  "markdown": "Apify: Full-stack web scraping and data extraction platform\n\n"
}]
```

## How much does URL to Markdown cost?

The price per page depends on your Apify plan and the selected mode. The table below shows the prices for 1,000 URLs:
| Apify plan | Raw HTTP mode |Browser mode|
|------------|---------------------|---------------------|
| Free       | $3                 | $6                  |
| Starter    | $2                | $5                 |
| Scale      | $1.70                | $4                  |
| Business   | $1.50                | $3                  |

## What are the Use cases for URL to markdown?

- **Get clean training data for LLM:** get clean, structured Markdown ready for model fine-tuning
- **Enhance your LLM:** provide your [LLM with custom knowledge](https://blog.apify.com/custom-gpts-knowledge/) to make it more accurate
- **Implement Retrieval** Augmented Generation (RAG)

## Integrate URL to Markdown with your AI ecosystem
Use [Apify platform integrations](https://docs.apify.com/integrations) to connect URL to Markdown with third-party tools.

[video integrations tutorial](https://www.youtube.com/watch?v=bNACk1_S_6w)

Top integrations to look at are:
- [LangChain](https://github.com/hwchase17/langchain): the most popular framework for developing applications powered by language models
- [Pinecone](https://apify.com/apify/pinecone-integration): a vector database to store the crawled data for semantic search.
- [OpenRouter](https://apify.com/apify/openrouter): give you access to multiple AI models through a unified OpenAI-compatible interface

## FAQ
### Why convert URLs to markdown?
Markdown is the perfect format to feed large language model (LLM). It is a less heavy format than HTML but still maintains the text structure like titles.

Using markdown instead of html can help you lower the AI token cost.


### Can I use URL to Markdown with the Apify API?
The Apify API gives you programmatic access to the Apify platform. The API is organized around RESTful HTTP endpoints that enable you to manage, schedule, and run Apify Actors. The API also lets you access any datasets, monitor Actor performance, fetch results, create and update versions, and more.

To access the API using Node.js, use the `apify-client` npm package. To access the API using Python, use the `apify-client` PyPI package. Check out the [Apify API reference](https://docs.apify.com/api/v2) docs for all the details.

### Can I use URL to Markdown through an MCP Server?
With Apify API, you can use almost any Actor in conjunction with an MCP server. You can connect to the MCP server using clients like ClaudeDesktop and LibreChat, or even build your own. Read all about how you can [set up Apify Actors with MCP](https://blog.apify.com/how-to-use-mcp/).

### Is scraping legal?
Web scraping is generally legal if you scrape publicly available non-personal data. What you do with the data is another question. Documentation, help articles, or blogs are typically protected by copyright, so you can't republish the content without the owner's permission.

Learn more about the legality of web scraping in [this blog post](https://blog.apify.com/is-web-scraping-legal/). If you're not sure, please seek professional legal advice.
