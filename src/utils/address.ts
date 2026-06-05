import { getAddress, isAddress } from 'ethers';

export function formatAddress(address: string, chars = 4): string {
  if (!isAddress(address)) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function checksumAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

export function addressEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function addressInList(address: string, list: string[]): boolean {
  const lower = address.toLowerCase();
  return list.some((a) => a.toLowerCase() === lower);
}
