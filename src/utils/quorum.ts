import type { Address, Hex, Quorum } from '../types';

export const calculateQuorumPower = (quorum: Quorum, signers: Address[] | Map<Address, Hex>): bigint => {
	const addresses = Array.isArray(signers) ? signers : [...signers.keys()];
	return addresses.reduce((sum, addr) => sum + (quorum.members[addr]?.shares ?? 0n), 0n);
};
