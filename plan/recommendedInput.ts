interface ServerInput {
  inputId: string;
  frameId: number;
  timestamp: number;
  serverTxs: ServerTx[];
  entityInputs: EntityInput[];
}

interface ServerTx {
  type: 'importEntity';
  entityId: string;
  data: any;
}

interface EntityInput {
  jurisdictionId: string;
  signerId: string;
  entityId: string;
  quorumProof: {
    quorumHash: string;
    quorumStructure: any;
  };
  entityTxs: EntityTx[]; // Jurisdiction events can be here
  precommits: string[];
  proposedBlock: string;
  observedInbox: InboxMessage[];
  accountInputs: AccountInput[];
}

interface EntityTx {
  type: string; // e.g., 'jurisdictionEvent', 'updateState'
  data: any;
}

interface InboxMessage {
  fromEntityId: string;
  message: any;
}

interface AccountInput {
  counterEntityId: string;
  accountTxs: AccountTx[];
}

interface AccountTx {
  type: 'AddPaymentSubcontract';
  paymentId: string;
  amount: number;
}
