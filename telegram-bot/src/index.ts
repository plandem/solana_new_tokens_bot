import { Worker } from "bullmq";
import * as winston from 'winston';
import TelegramBot from 'node-telegram-bot-api';

enum TokenStandard {
    NonFungible,
    FungibleAsset,
    Fungible,
    NonFungibleEdition,
    ProgrammableNonFungible,
    ProgrammableNonFungibleEdition,
}

let processTimerId:NodeJS.Timeout;

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

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const worker = new Worker(process.env.QUEUE_NAME, null, {
    // concurrency: 100,
    connection: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
    }
});

async function onExit() {
    console.log('[telegram-bot] exit...')
    await worker.close();
    if(processTimerId) {
        clearTimeout(processTimerId)
    }

    process.exit(0);
}

process.on('SIGINT', onExit);
process.on('SIGQUIT', onExit);
process.on('SIGTERM', onExit);

async function notify(payload:any) {
    try {
        const message =
`
Имя токена: "${payload.name}"
Символ токена: "${payload.symbol}"
Тип токена: ${TokenStandard[payload.tokenStandard]}
[Адрес токена](https://solscan.io/token/${payload.mint})
[Адрес деплоера](https://solscan.io/account/${payload.signer})
`;

        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
        logger.info("notify", { message });
        return true;
    } catch(err) {
        logger.error("notify", { err })
        return false;
    }
}

async function process_jobs() {
    let job;
    try {
        job = await worker.getNextJob(process.env.TAG_NEW_TOKENS);
    } catch(err) {
        logger.error("getNextJob", { err })
    }

    if (job) {
        try {
            const success = await notify(job.data);
            if (success) {
                await job.moveToCompleted(null, process.env.TAG_NEW_TOKENS);
                job = null;
            } else {
                await job.moveToFailed(new Error('some error message'), process.env.TAG_NEW_TOKENS);
                job = null;
            }


        } catch(err) {
            logger.error("moveTo", { err })
            //TODO: add logic to update job's status in case if redis failed
        }
    }

    processTimerId = setTimeout(process_jobs, 1000);
}

processTimerId = setTimeout(process_jobs, 1000);
