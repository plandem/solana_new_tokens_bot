import bs58 from 'bs58';
import WebSocket from "ws";
import * as winston from 'winston';
import { Queue } from "bullmq";

import {
    getCreateV1InstructionDataSerializer as createMetaDataV1Serializer,
    getDataV2Serializer as createMetaDataV2Serializer,
    MPL_TOKEN_METADATA_PROGRAM_ID,
} from '@metaplex-foundation/mpl-token-metadata';

// TODO: Could not find exported values in new versions
enum MetaplexInstructionDiscriminator {
    CreateV1 = 42,
    CreateV3 = 33,
}

enum Accounts {
    Metadata,
    MasterEdition,
    Mint,
    Authority,
    Payer,
    UpdateAuthority,
    SystemProgram,
    SysvarInstructions,
    SplTokenProgram,
    Rent,
}

// ordered accounts
const MetaplexAccountsV1 = [
    Accounts.Metadata,
    Accounts.MasterEdition,
    Accounts.Mint,
    Accounts.Authority,
    Accounts.Payer,
    Accounts.UpdateAuthority,
    Accounts.SystemProgram,
    Accounts.SysvarInstructions,
    Accounts.SplTokenProgram
];

// ordered accounts
const MetaplexAccountsV2 = [
    Accounts.Metadata,
    Accounts.Mint,
    Accounts.Authority,
    Accounts.Payer,
    Accounts.UpdateAuthority,
    Accounts.SystemProgram,
    Accounts.Rent,
];

interface RpcRequestParam {
    [x: string]: any;
    [x: number]: any;
}

let enqueueTimerId:NodeJS.Timeout;
let enqueuePayloads:any[] = [];

const mpl_metadata_v1 = createMetaDataV1Serializer();
const mpl_metadata_v2 = createMetaDataV2Serializer();

const ws = new WebSocket(process.env.WSS_NODE);
const queue = new Queue(process.env.QUEUE_NAME, { connection: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
    },
    defaultJobOptions: {
        removeOnComplete: true, removeOnFail: { count: 10 }
    }
});

//TODO: naive logger, it should be Sentry or something else
const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
            )
        })
    ]
});

function *create_request_id(initial = 0) {
    let id:number = initial;
    while (true) {
        yield ++id;
    }
}

const get_request_id:Generator<number> = create_request_id();

async function rpc_call(method: string, params?: RpcRequestParam[], request_id?: number) {
    logger.verbose("rpc_call", { method })

    const id:number = request_id || get_request_id.next().value
    const payload = {
        jsonrpc: "2.0",
        id,
        method,
        params,
    }

    try {
        await ws.send(JSON.stringify(payload));
        return id
    } catch(err) {
        logger.error('rpc_call', { err });
        throw err
    }
}

async function blockSubscribe() {
    try {
        return await rpc_call("blockSubscribe", [
            {
                "mentionsAccountOrProgram": MPL_TOKEN_METADATA_PROGRAM_ID
            },
            {
                commitment: "confirmed",
                encoding: "jsonParsed",
                maxSupportedTransactionVersion: 0,
                transactionDetails: "full",
                showRewards: false,
            }
        ]);
    } catch(err) {
        logger.error("blockSubscribe", { err })
        throw err
    }
}

async function blockUnsubscribe(request_id:number) {
    try{
        await rpc_call("blockUnsubscribe", [], request_id);
    } catch(err) {
        logger.error("blockUnsubscribe", { request_id, err })
        throw err
    }
}

function ping() {
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
            logger.verbose("ws-ping")
        }
    }, 30 * 1000);
}

//TODO: try to subscribe for few times before failing
ws.on('open', async () => {
    logger.verbose("ws-open")
    const request_id = await blockSubscribe();

    // cleanup if terminated
    const onExit = async () => {
        logger.verbose("ws-exit")
        await blockUnsubscribe(request_id);
        ws.close();
        if(enqueueTimerId) {
            clearTimeout(enqueueTimerId)
        }

        process.exit(0);
    }

    process.on('SIGINT', onExit);
    process.on('SIGQUIT', onExit);
    process.on('SIGTERM', onExit);

    // keep connection. probably need more testing to make sure that connection is alive
    ping();
});

// low-level handler for messages that re-emit with specific method to simplify processing
ws.on('message',  (message:any) => {
    if (message instanceof ArrayBuffer)
        message = Buffer.from(message).toString('utf8');

    try {
        message = JSON.parse(message);

        // make processing async
        if (message.method) {
            Promise.resolve().then(() => {
                ws.emit(`message:${message.method}`, message?.params)
            });
        }
    } catch (err) {
        logger.error("ws-message", { err})
    }
});

ws.on('error', (err) => {
    logger.error("ws-message", { err})
});

ws.on('close', () => {
    logger.verbose("ws-close")
});

ws.on("message:blockNotification", (data) => {
    const { result: { value: { block }}} : { result: { value: { block }}} = data;

    block.transactions.forEach((tx) => {
        tx.transaction.message.instructions.forEach((ix) => {
            // skip any irrelevant instructions
            if (ix.programId != MPL_TOKEN_METADATA_PROGRAM_ID) {
                return
            }

            try {
                const data = bs58.decode(ix.data);
                const payload = {
                    version: null,
                    symbol: null,
                    name: null,
                    tokenStandard: null,
                    mint:null,
                    signer: null,
                };

                // discriminator is the first byte, always
                let metadata;
                switch (data[0]) {
                    case MetaplexInstructionDiscriminator.CreateV1:
                        [metadata,] = mpl_metadata_v1.deserialize(data);
                        Object.assign(payload, {
                            version: 1,
                            mint: ix.accounts[MetaplexAccountsV1.findIndex( acc => acc === Accounts.Mint)],
                            signer: ix.accounts[MetaplexAccountsV1.findIndex( acc => acc === Accounts.Authority)],
                        })
                        break;
                    case MetaplexInstructionDiscriminator.CreateV3:
                        [metadata,] = mpl_metadata_v2.deserialize(data);
                        Object.assign(payload, {
                            version: 2,
                            mint: ix.accounts[MetaplexAccountsV2.findIndex( acc => acc === Accounts.Mint)],
                            signer: ix.accounts[MetaplexAccountsV2.findIndex( acc => acc === Accounts.Authority)],
                        })
                        break;
                    default:
                        return;
                }

               Object.assign(payload, {
                    symbol: metadata.symbol,
                    name: metadata.name,
                    tokenStandard: metadata.tokenStandard,
                })

                enqueuePayloads.push({
                    name: process.env.TAG_NEW_TOKENS,
                    data: payload
                });
            } catch(err) {
                // log failed decoding to analyze later
                logger.error("ws-blockNotification", { tx: tx.transaction.signatures[0], err })
            }
        });
    });
});

//FIXME: naive queue, `addBulk` should be used by chunks in case if redis was offline for unreasonable time
async function enqueue() {
    if(enqueuePayloads.length) {
        logger.verbose("enqueue tokens")
        try {
            await queue.addBulk(enqueuePayloads);
            enqueuePayloads.splice(0, enqueuePayloads.length);
        } catch(err) {
            logger.error("enqueue tokens", { err });
        }
    }

    enqueueTimerId = setTimeout(enqueue, 1000);
}

enqueueTimerId = setTimeout(enqueue, 1000);
