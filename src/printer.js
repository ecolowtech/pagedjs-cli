const Paged = require('pagedjs');
const EventEmitter = require('events');
const puppeteer = require('puppeteer');
const util = require('util');
const fs = require('fs');
const fetch = require("node-fetch");

const path = require('path');

let dir = process.cwd();

// Find top most pagedjs
let pagedjsLocation = require.resolve("pagedjs/dist/paged.polyfill.js");
let paths = pagedjsLocation.split("node_modules");
let scriptPath = paths[0] + "node_modules" + paths[paths.length-1];

const PostProcesser = require('./postprocesser');

class Printer extends EventEmitter {
  constructor(headless, allowLocal) {
    super();
    this.headless = headless !== false;
    this.allowLocal = allowLocal;
    this.pages = [];
  }

  async setup() {
    const browser = await puppeteer.launch({
      headless: this.headless,
      args: this.allowLocal ? ['--allow-file-access-from-files', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'],
      ignoreHTTPSErrors: true
    });

    this.browser = browser;

    return browser;
  }

  async render(input) {
    let resolver;
    let rendered = new Promise(function(resolve, reject) {
      resolver = resolve;
    });

    if (!this.browser) {
      await this.setup();
    }

    const page = await this.browser.newPage();

    let uri, url, html;
    if (typeof input === "string") {
      try {
        uri = new URL(input);
        if (uri.protocol === "https:") {
          html = await fetch(input)
            .then(res => res.text())
        }
        url = input;
      } catch {
        let relativePath = path.resolve(dir, input);
        url = "file://" + relativePath;
      }
    } else {
      url = input.url;
      html = input.html;
    }

    if (html) {
      await page.setContent(html)
        .catch((e) => {
          console.error(e);
        });

      if (url) {
        await page.evaluate((url) => {
          let base = document.querySelector("base");
          if (!base) {
            base = document.createElement("base");
            document.querySelector("head").appendChild(base);
          }
          base.setAttribute("href", url);
        }, url);
      }

    } else {
      await page.goto(url)
        .catch((e) => {
          console.error(e);
        });
    }

    await page.evaluate(() => {
      window.PagedConfig = window.PagedConfig || {};
      window.PagedConfig.auto = false;
    });



    await page.addScriptTag({
      path: scriptPath
    });

    // await page.exposeFunction('PuppeteerLogger', (msg) => {
    //   console.log(msg);
    // });

    await page.exposeFunction('onSize', (size) => {
      this.emit("size", size);
    });

    await page.exposeFunction('onPage', (page) => {
      // console.log("page", page.position + 1);

      this.pages.push(page);

      this.emit("page", page);
    });

    await page.exposeFunction('onRendered', (msg, width, height, orientation) => {
      this.emit("rendered", msg, width, height, orientation);
      resolver({msg, width, height, orientation});
    });

    await page.evaluate(() => {
      window.PagedPolyfill.on("page", (page) => {
        const { id, width, height, startToken, endToken, breakAfter, breakBefore, position } = page;

        const mediabox = page.element.getBoundingClientRect();
        const cropbox = page.pagebox.getBoundingClientRect();

        function getPointsValue(value) {
          return (Math.round(CSS.px(value).to("pt").value * 100) / 100);
        }

        let boxes = {
          media: {
            width: getPointsValue(mediabox.width),
            height: getPointsValue(mediabox.height),
            x: 0,
            y: 0
          },
          crop: {
            width: getPointsValue(cropbox.width),
            height: getPointsValue(cropbox.height),
            x: getPointsValue(cropbox.x) - getPointsValue(mediabox.x),
            y: getPointsValue(cropbox.y) - getPointsValue(mediabox.y)
          }
        }

        window.onPage({ id, width, height, startToken, endToken, breakAfter, breakBefore, position, boxes });
      });

      window.PagedPolyfill.on("size", (size) => {
        window.onSize(size);
      });

      window.PagedPolyfill.on("rendered", (flow) => {
        let msg = "Rendering " + flow.total + " pages took " + flow.performance + " milliseconds.";
        window.onRendered(msg, flow.width, flow.height, flow.orientation);
      });

      window.PagedPolyfill.preview();
    });

    await rendered;

    await page.waitForSelector(".pagedjs_pages");

    return page;
  }

  async pdf(input, options={}) {
    let page = await this.render(input);

    // Get metatags
    const meta = await page.evaluate(() => {
      let meta = {};
      let title = document.querySelector("title");
      if (title) {
        meta.title = title.textContent.trim();
      }
      let metaTags = document.querySelectorAll("meta");
      [...metaTags].forEach((tag) => {
        if (tag.name) {
          meta[tag.name] = tag.content;
        }
      })
      return meta;
    });

    let settings = {
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: options.width ? false : true,
      width: options.width,
      height: options.height,
      orientation: options.orientation,
      margin: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }
    }

    let pdf = await page.pdf(settings)
      .catch((e) => {
        console.error(e);
      });

    await page.close();

    this.emit("postprocessing");

    let post = new PostProcesser(pdf);
    post.metadata(meta);
    post.boxes(this.pages);
    pdf = post.save();

    return pdf;
  }

  async html(input, stayopen) {
    let page = await this.render(input);

    let content = await page.content()
      .catch((e) => {
        console.error(e);
      });

    await page.close();
    return content;
  }

  async preview(input) {
    let page = await this.render(input);
    return page;
  }

  async close() {
    return this.browser.close();
  }

}

module.exports = Printer;
