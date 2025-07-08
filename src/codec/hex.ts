import type { Hex } from '../types';

export const hexToBuf = (hex: Hex): Buffer => Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');

export const bufToHex = (buf: Buffer): Hex => `0x${buf.toString('hex')}`;
