import { _getDefaults } from './defaults.js';
import { _Lexer } from './Lexer.ts';
import { _Parser } from './Parser.ts';
import { _Hooks } from './Hooks.ts';
import { _Renderer } from './Renderer.ts';
import { _Tokenizer } from './Tokenizer.ts';
import { _TextRenderer } from './TextRenderer.ts';
import { _Slugger } from './Slugger.ts';
import {
  checkDeprecations,
  escape
} from './helpers.ts';
import type { MarkedExtension, MarkedOptions } from './MarkedOptions.ts';
import type { Token, TokensList } from './Tokens.ts';

export type ResultCallback = (error: Error | null, parseResult?: string) => undefined | void;

export class Marked {
  defaults = _getDefaults();
  options = this.setOptions;

  parse = this.#parseMarkdown(_Lexer.lex, _Parser.parse);
  parseInline = this.#parseMarkdown(_Lexer.lexInline, _Parser.parseInline);

  Parser = _Parser;
  parser = _Parser.parse;
  Renderer = _Renderer;
  TextRenderer = _TextRenderer;
  Lexer = _Lexer;
  lexer = _Lexer.lex;
  Tokenizer = _Tokenizer;
  Slugger = _Slugger;
  Hooks = _Hooks;

  constructor(...args: MarkedExtension[]) {
    this.use(...args);
  }

  /**
   * Run callback for every token
   */
  walkTokens <T = void>(tokens: Token[] | TokensList, callback: (token: Token) => T | T[]) {
    let values: T[] = [];
    for (const token of tokens) {
      values = values.concat(callback.call(this, token));
      switch (token.type) {
        case 'table': {
          for (const cell of token.header) {
            values = values.concat(this.walkTokens(cell.tokens!, callback));
          }
          for (const row of token.rows) {
            for (const cell of row) {
              values = values.concat(this.walkTokens(cell.tokens!, callback));
            }
          }
          break;
        }
        case 'list': {
          values = values.concat(this.walkTokens(token.items, callback));
          break;
        }
        default: {
          if (this.defaults.extensions && this.defaults.extensions.childTokens && this.defaults.extensions.childTokens[token.type]) { // Walk any extensions
            this.defaults.extensions.childTokens[token.type].forEach((childTokens) => {
              values = values.concat(this.walkTokens(token[childTokens], callback));
            });
          } else if (token.tokens) {
            values = values.concat(this.walkTokens(token.tokens, callback));
          }
        }
      }
    }
    return values;
  }

  use(...args: MarkedExtension[]) {
    const extensions: NonNullable<MarkedOptions['extensions']> = this.defaults.extensions || { renderers: {}, childTokens: {} } as NonNullable<MarkedOptions['extensions']>;

    args.forEach((pack) => {
      // copy options to new object
      const opts = { ...pack } as MarkedOptions;

      // set async to true if it was set to true before
      opts.async = this.defaults.async || opts.async || false;

      // ==-- Parse "addon" extensions --== //
      if (pack.extensions) {
        pack.extensions.forEach((ext) => {
          if (!ext.name) {
            throw new Error('extension name required');
          }
          if ('renderer' in ext) { // Renderer extensions
            const prevRenderer = extensions.renderers[ext.name];
            if (prevRenderer) {
              // Replace extension with func to run new extension but fall back if false
              extensions.renderers[ext.name] = function(...args) {
                let ret = ext.renderer.apply(this, args);
                if (ret === false) {
                  ret = prevRenderer.apply(this, args);
                }
                return ret;
              };
            } else {
              extensions.renderers[ext.name] = ext.renderer;
            }
          }
          if ('tokenizer' in ext) { // Tokenizer Extensions
            if (!ext.level || (ext.level !== 'block' && ext.level !== 'inline')) {
              throw new Error("extension level must be 'block' or 'inline'");
            }
            if (extensions[ext.level]) {
              extensions[ext.level].unshift(ext.tokenizer);
            } else {
              extensions[ext.level] = [ext.tokenizer];
            }
            if (ext.start) { // Function to check for start of token
              if (ext.level === 'block') {
                if (extensions.startBlock) {
                  extensions.startBlock.push(ext.start!);
                } else {
                  extensions.startBlock = [ext.start!];
                }
              } else if (ext.level === 'inline') {
                if (extensions.startInline) {
                  extensions.startInline.push(ext.start!);
                } else {
                  extensions.startInline = [ext.start!];
                }
              }
            }
          }
          if ('childTokens' in ext && ext.childTokens) { // Child tokens to be visited by walkTokens
            extensions.childTokens[ext.name] = ext.childTokens;
          }
        });
        opts.extensions = extensions;
      }

      // ==-- Parse "overwrite" extensions --== //
      if (pack.renderer) {
        const renderer = this.defaults.renderer || new _Renderer(this.defaults);
        for (const prop in pack.renderer) {
          const prevRenderer = renderer[prop];
          // Replace renderer with func to run extension, but fall back if false
          renderer[prop] = (...args: unknown[]) => {
            let ret = pack.renderer![prop].apply(renderer, args);
            if (ret === false) {
              ret = prevRenderer.apply(renderer, args);
            }
            return ret;
          };
        }
        opts.renderer = renderer;
      }
      if (pack.tokenizer) {
        const tokenizer = this.defaults.tokenizer || new _Tokenizer(this.defaults);
        for (const prop in pack.tokenizer) {
          const prevTokenizer = tokenizer[prop];
          // Replace tokenizer with func to run extension, but fall back if false
          tokenizer[prop] = (...args: unknown[]) => {
            let ret = pack.tokenizer![prop].apply(tokenizer, args);
            if (ret === false) {
              ret = prevTokenizer.apply(tokenizer, args);
            }
            return ret;
          };
        }
        opts.tokenizer = tokenizer;
      }

      // ==-- Parse Hooks extensions --== //
      if (pack.hooks) {
        const hooks = this.defaults.hooks || new _Hooks();
        for (const prop in pack.hooks) {
          const prevHook = hooks[prop];
          if (_Hooks.passThroughHooks.has(prop)) {
            hooks[prop as 'preprocess' | 'postprocess'] = (arg: string | undefined) => {
              if (this.defaults.async) {
                return Promise.resolve(pack.hooks![prop].call(hooks, arg)).then(ret => {
                  return prevHook.call(hooks, ret);
                });
              }

              const ret = pack.hooks![prop].call(hooks, arg);
              return prevHook.call(hooks, ret);
            };
          } else {
            hooks[prop] = (...args) => {
              let ret = pack.hooks![prop].apply(hooks, args);
              if (ret === false) {
                ret = prevHook.apply(hooks, args);
              }
              return ret;
            };
          }
        }
        opts.hooks = hooks;
      }

      // ==-- Parse WalkTokens extensions --== //
      if (pack.walkTokens) {
        const walkTokens = this.defaults.walkTokens;
        opts.walkTokens = function(token) {
          let values: Array<Promise<void> | void> = [];
          values.push(pack.walkTokens!.call(this, token));
          if (walkTokens) {
            values = values.concat(walkTokens.call(this, token));
          }
          return values;
        };
      }

      this.defaults = { ...this.defaults, ...opts };
    });

    return this;
  }

  setOptions(opt) {
    this.defaults = { ...this.defaults, ...opt };
    return this;
  }

  #parseMarkdown(lexer: (src: string, options?: MarkedOptions) => TokensList | Token[], parser: (tokens: Token[], options?: MarkedOptions) => string | undefined) {
    return (src: string, optOrCallback?: MarkedOptions | ResultCallback | undefined | null, callback?: ResultCallback | undefined): string | Promise<string | undefined> | undefined => {
      if (typeof optOrCallback === 'function') {
        callback = optOrCallback;
        optOrCallback = null;
      }

      const origOpt = { ...optOrCallback };
      const opt = { ...this.defaults, ...origOpt };
      const throwError = this.#onError(!!opt.silent, !!opt.async, callback);

      // throw error in case of non string input
      if (typeof src === 'undefined' || src === null) {
        return throwError(new Error('marked(): input parameter is undefined or null'));
      }
      if (typeof src !== 'string') {
        return throwError(new Error('marked(): input parameter is of type '
          + Object.prototype.toString.call(src) + ', string expected'));
      }

      checkDeprecations(opt, callback);

      if (opt.hooks) {
        opt.hooks.options = opt;
      }

      if (callback) {
        const highlight = opt.highlight;
        let tokens: TokensList | Token[];

        try {
          if (opt.hooks) {
            src = opt.hooks.preprocess(src);
          }
          tokens = lexer(src, opt);
        } catch (e) {
          return throwError(e as Error);
        }

        const done = (err?: Error) => {
          let out;

          if (!err) {
            try {
              if (opt.walkTokens) {
                this.walkTokens(tokens, opt.walkTokens);
              }
              out = parser(tokens, opt)!;
              if (opt.hooks) {
                out = opt.hooks.postprocess(out);
              }
            } catch (e) {
              err = e as Error;
            }
          }

          opt.highlight = highlight;

          return err
            ? throwError(err)
            : callback!(null, out) as undefined;
        };

        if (!highlight || highlight.length < 3) {
          return done();
        }

        delete opt.highlight;

        if (!tokens.length) return done();

        let pending = 0;
        this.walkTokens(tokens, (token) => {
          if (token.type === 'code') {
            pending++;
            setTimeout(() => {
              highlight(token.text, token.lang, (err, code) => {
                if (err) {
                  return done(err);
                }
                if (code != null && code !== token.text) {
                  token.text = code;
                  token.escaped = true;
                }

                pending--;
                if (pending === 0) {
                  done();
                }
              });
            }, 0);
          }
        });

        if (pending === 0) {
          done();
        }

        return;
      }

      if (opt.async) {
        return Promise.resolve(opt.hooks ? opt.hooks.preprocess(src) : src)
          .then(src => lexer(src, opt))
          .then(tokens => opt.walkTokens ? Promise.all(this.walkTokens(tokens, opt.walkTokens)).then(() => tokens) : tokens)
          .then(tokens => parser(tokens, opt))
          .then(html => opt.hooks ? opt.hooks.postprocess(html) : html)
          .catch(throwError);
      }

      try {
        if (opt.hooks) {
          src = opt.hooks.preprocess(src);
        }
        const tokens = lexer(src, opt);
        if (opt.walkTokens) {
          this.walkTokens(tokens, opt.walkTokens);
        }
        let html = parser(tokens, opt);
        if (opt.hooks) {
          html = opt.hooks.postprocess(html);
        }
        return html;
      } catch (e) {
        return throwError(e as Error);
      }
    };
  }

  #onError(silent: boolean, async: boolean, callback?: ResultCallback) {
    return (e: Error): string | Promise<string> | undefined => {
      e.message += '\nPlease report this to https://github.com/markedjs/marked.';

      if (silent) {
        const msg = '<p>An error occurred:</p><pre>'
          + escape(e.message + '', true)
          + '</pre>';
        if (async) {
          return Promise.resolve(msg);
        }
        if (callback) {
          callback(null, msg);
          return;
        }
        return msg;
      }

      if (async) {
        return Promise.reject(e);
      }
      if (callback) {
        callback(e);
        return;
      }
      throw e;
    };
  }
}
