import { describe, expect, it } from 'vitest';
import { createJsonParser } from '../parsers';

interface Quote {
  symbol: string;
  price: number;
}

const isQuote = (value: unknown): value is Quote => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Quote>;
  return typeof candidate.symbol === 'string' && typeof candidate.price === 'number';
};

describe('createJsonParser', () => {
  it('parses a single object', () => {
    const parse = createJsonParser<Quote>();
    expect(parse('{"symbol":"AAPL","price":1}')).toEqual({ symbol: 'AAPL', price: 1 });
  });

  it('parses an array as a batch', () => {
    const parse = createJsonParser<Quote>();
    expect(parse('[{"symbol":"AAPL","price":1},{"symbol":"MSFT","price":2}]')).toEqual([
      { symbol: 'AAPL', price: 1 },
      { symbol: 'MSFT', price: 2 },
    ]);
  });

  it('rejects a payload the guard does not recognise', () => {
    const parse = createJsonParser(isQuote);
    expect(parse('{"type":"heartbeat"}')).toBeNull();
    expect(parse('{"symbol":"AAPL","price":"not a number"}')).toBeNull();
  });

  it('keeps the good entries in a partially bad batch', () => {
    const parse = createJsonParser(isQuote);
    expect(parse('[{"symbol":"AAPL","price":1},{"nope":true}]')).toEqual([
      { symbol: 'AAPL', price: 1 },
    ]);
  });

  it('returns null for a batch with nothing usable in it', () => {
    const parse = createJsonParser(isQuote);
    expect(parse('[{"nope":true},null]')).toBeNull();
    expect(parse('[]')).toBeNull();
  });

  it('ignores non-string payloads such as binary frames', () => {
    const parse = createJsonParser<Quote>();
    expect(parse(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parse(new ArrayBuffer(4))).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('throws on invalid JSON, which the feed turns into a dropped message', () => {
    const parse = createJsonParser<Quote>();
    expect(() => parse('{"symbol":"AAPL","pri')).toThrow();
    expect(() => parse('<html>502 Bad Gateway</html>')).toThrow();
  });
});
