
export interface ProtocolWhitelistRecord {
  id: string;
  clientId: string | null;
  protocolName: string;
  contractAddresses: Record<number, string[]>;
  isActive: boolean;
  createdAt: Date;
}

export interface AddressWhitelistRecord {
  id: string;
  clientId: string | null;
  address: string;
  label: string | null;
  chainIds: number[];
  isActive: boolean;
  createdAt: Date;
}

export interface CreateProtocolWhitelistInput {
  clientId?: string;
  protocolName: string;
  contractAddresses: Record<number, string[]>;
}

export interface CreateAddressWhitelistInput {
  clientId?: string;
  address: string;
  label?: string;
  chainIds?: number[];
}
