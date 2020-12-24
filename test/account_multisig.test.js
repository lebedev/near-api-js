/* global BigInt */
const nearApi = require('../lib/index');
const fs = require('fs');
const BN = require('bn.js');
const testUtils  = require('./test-utils');
const semver = require('semver');

let nearjs;
let startFromVersion;

const {
    KeyPair,
    transactions: { functionCall },
    InMemorySigner,
    multisig: { Account2FA, MULTISIG_GAS, MULTISIG_DEPOSIT },
    utils: { format: { parseNearAmount } }
} = nearApi;

jasmine.DEFAULT_TIMEOUT_INTERVAL = 50000;

const getAccount2FA = async (account, keyMapping = ({ public_key: publicKey }) => ({ publicKey, kind: 'phone' })) => {
    // modifiers to functions replaces contract helper (CH)
    const { accountId } = account;
    const account2fa = new Account2FA(account.connection, accountId, {
        // skip this (not using CH)
        getCode: () => {},
        sendCode: () => {},
        // auto accept "code"
        verifyCode: () => ({ success: true, res: '' }),
        onAddRequestResult: async () => {
            const { requestId } = account2fa.getRequest();
            // set confirmKey as signer
            const originalSigner = nearjs.connection.signer;
            nearjs.connection.signer = await InMemorySigner.fromKeyPair(nearjs.connection.networkId, accountId, account2fa.confirmKey);
            // 2nd confirmation signing with confirmKey from Account instance
            await account.signAndSendTransaction(accountId, [
                functionCall('confirm', { request_id: requestId }, MULTISIG_GAS, MULTISIG_DEPOSIT)
            ]);
            nearjs.connection.signer = originalSigner;
        }
    });
    account2fa.newKeyPair = KeyPair.fromRandom('ed25519');
    const newLocalPublicKey = account2fa.newKeyPair.publicKey;
    account2fa.newLocalPublicKey = newLocalPublicKey;
    account2fa.confirmKey = KeyPair.fromRandom('ed25519');
    account2fa.postSignedJson = () => ({ publicKey: account2fa.confirmKey.getPublicKey() });
    account2fa.getRecoveryMethods = async () => ({
        data: (await account.getAccessKeys()).map(keyMapping)
    });
    await account2fa.deployMultisig([...fs.readFileSync('./test/data/multisig.wasm')], newLocalPublicKey);
    account2fa.connection.signer = await InMemorySigner.fromKeyPair(nearjs.connection.networkId, accountId, account2fa.newKeyPair);
    return account2fa;
};

beforeEach(async () => {
    nearjs = await testUtils.setUpTestConnection();
    let nodeStatus = await nearjs.connection.provider.status();
    startFromVersion = (version) => semver.gte(nodeStatus.version.version, version);
    console.log(startFromVersion);
});

describe('deployMultisig key rotations', () => {

    test('full access key if recovery method is "ledger" or "phrase", limited access key if "phone"', async () => {
        const account = await testUtils.createAccount(nearjs);
        const ledgerKey = KeyPair.fromRandom('ed25519').getPublicKey();
        await account.addKey(ledgerKey);
        const seedKey = KeyPair.fromRandom('ed25519').getPublicKey();
        await account.addKey(seedKey);
        const account2fa = await getAccount2FA(
            account,
            ({ public_key: publicKey }) => {
                const recoveryMethod = { publicKey };
                if (publicKey === ledgerKey.toString()) recoveryMethod.kind = 'ledger';
                else if (publicKey === seedKey.toString()) recoveryMethod.kind = 'phrase';
                else recoveryMethod.kind = 'phone';
                return recoveryMethod;
            }
        );
        const currentKeys = await account2fa.getAccessKeys();
        expect(currentKeys.find(({ public_key }) => public_key === ledgerKey.toString()).access_key.permission).toEqual('FullAccess');
        expect(currentKeys.find(({ public_key }) => public_key === seedKey.toString()).access_key.permission).toEqual('FullAccess');
        expect(currentKeys.find(({ public_key }) => public_key === account2fa.newLocalPublicKey.toString()).access_key.permission).not.toEqual('FullAccess');
    });
    
});

describe('account2fa transactions', () => {

    test('add app key before deployMultisig', async() => {
        let account = await testUtils.createAccount(nearjs);
        const appPublicKey = KeyPair.fromRandom('ed25519').getPublicKey();
        const appAccountId = 'foobar';
        const appMethodNames = ['some_app_stuff','some_more_app_stuff'];
        await account.addKey(appPublicKey.toString(), appAccountId, appMethodNames, new BN(parseNearAmount('0.25')));
        account = await getAccount2FA(account);
        const keys = await account.getAccessKeys();
        expect(keys.find(({ public_key }) => appPublicKey.toString() === public_key)
            .access_key.permission.FunctionCall.method_names).toEqual(appMethodNames);
        expect(keys.find(({ public_key }) => appPublicKey.toString() === public_key)
            .access_key.permission.FunctionCall.receiver_id).toEqual(appAccountId);
    });

    test('add app key', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const appPublicKey = KeyPair.fromRandom('ed25519').getPublicKey();
        const appAccountId = 'foobar';
        const appMethodNames = ['some_app_stuff', 'some_more_app_stuff'];
        await account.addKey(appPublicKey.toString(), appAccountId, appMethodNames, new BN(parseNearAmount('0.25')));
        const keys = await account.getAccessKeys();
        expect(keys.find(({ public_key }) => appPublicKey.toString() === public_key)
            .access_key.permission.FunctionCall.method_names).toEqual(appMethodNames);
        expect(keys.find(({ public_key }) => appPublicKey.toString() === public_key)
            .access_key.permission.FunctionCall.receiver_id).toEqual(appAccountId);
    });

    test('send money', async() => {
        let sender = await testUtils.createAccount(nearjs);
        const nearjs2 = await testUtils.setUpTestConnection();
        let receiver = await testUtils.createAccount(nearjs2);
        sender = await getAccount2FA(sender);
        receiver = await getAccount2FA(receiver);
        const { amount: receiverAmount } = await receiver.state();
        await sender.sendMoney(receiver.accountId, new BN(parseNearAmount('1')));
        await receiver.fetchState();
        const state = await receiver.state();
        expect(BigInt(state.amount)).toBeGreaterThanOrEqual(BigInt(new BN(receiverAmount).add(new BN(parseNearAmount('0.9'))).toString()));
    });
    
});


describe('account2fa disable / re-enable key rotations', () => {

    test('test disable', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const keys = (await account.getAccessKeys()).map(({ public_key }) => public_key);
        const newLocalPublicKey = KeyPair.fromRandom('ed25519').getPublicKey();
        await account.disable([...fs.readFileSync('./test/data/main.wasm')], newLocalPublicKey);
        const keys2 = await account.getAccessKeys();
        expect(keys2[0].public_key).toEqual(newLocalPublicKey.toString());
        expect(keys.find((public_key) => keys2[0].public_key === public_key)).toEqual(undefined);
    });

    test('test disable and re-enable', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const keys = (await account.getAccessKeys()).map(({ public_key }) => public_key);
        const newKeyPair = KeyPair.fromRandom('ed25519');
        await account.disable([...fs.readFileSync('./test/data/main.wasm')], newKeyPair.getPublicKey());
        account.connection.signer = await InMemorySigner.fromKeyPair(nearjs.connection.networkId, account.accountId, newKeyPair);
        account = await getAccount2FA(account);
        const keys2 = await account.getAccessKeys();
        expect(keys2.find(({public_key}) => public_key === account.newLocalPublicKey.toString())).not.toEqual(undefined);
        expect(keys.find((public_key) => keys2[0].public_key === public_key)).toEqual(undefined);
    });
    
});

describe('RetriesExceeded error with account2fa disable / re-enable key rotations', () => {

    test('test disable', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const keys = (await account.getAccessKeys()).map(({ public_key }) => public_key);
        const newLocalPublicKey = KeyPair.fromRandom('ed25519').getPublicKey();
        // sim error
        account.signAndSendTransactionTemp = account.signAndSendTransaction;
        account.signAndSendTransaction = async (...args) => {
            await account.signAndSendTransactionTemp(...args);
            throw new Error('RetriesExceeded');
        };
        await account.disable([...fs.readFileSync('./test/data/main.wasm')], newLocalPublicKey);
        const keys2 = await account.getAccessKeys();
        expect(keys2[0].public_key).toEqual(newLocalPublicKey.toString());
        expect(keys.find((public_key) => keys2[0].public_key === public_key)).toEqual(undefined);
    });

    test('test disable and re-enable', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const keys = (await account.getAccessKeys()).map(({ public_key }) => public_key);
        const newKeyPair = KeyPair.fromRandom('ed25519');
        await account.disable([...fs.readFileSync('./test/data/main.wasm')], newKeyPair.getPublicKey());
        account.connection.signer = await InMemorySigner.fromKeyPair(nearjs.connection.networkId, account.accountId, newKeyPair);
        // sim error
        account.signAndSendTransactionWithAccountTemp = account.signAndSendTransactionWithAccount;
        account.signAndSendTransactionWithAccount = async (...args) => {
            await account.signAndSendTransactionWithAccountTemp(...args);
            throw new Error('RetriesExceeded');
        };
        account = await getAccount2FA(account);
        const keys2 = await account.getAccessKeys();
        expect(keys2.find(({public_key}) => public_key === account.newLocalPublicKey.toString())).not.toEqual(undefined);
        expect(keys.find((public_key) => keys2[0].public_key === public_key)).toEqual(undefined);
    });
    
});

const someError = 'SomeError';

describe('error with account2fa disable / re-enable key rotations', () => {

    test('test disable', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const newLocalPublicKey = KeyPair.fromRandom('ed25519').getPublicKey();
        // sim error
        account.signAndSendTransactionTemp = account.signAndSendTransaction;
        account.signAndSendTransaction = async (...args) => {
            console.log('signAndSendTransactionTemp');
            await account.signAndSendTransactionTemp(...args);
            throw new Error(someError);
        };
        try {
            await account.disable([...fs.readFileSync('./test/data/main.wasm')], newLocalPublicKey);
        } catch (e) {
            expect(e.message).toEqual(someError);
        }
    });

    test('test disable and re-enable', async() => {
        let account = await testUtils.createAccount(nearjs);
        account = await getAccount2FA(account);
        const newKeyPair = KeyPair.fromRandom('ed25519');
        await account.disable([...fs.readFileSync('./test/data/main.wasm')], newKeyPair.getPublicKey());
        account.connection.signer = await InMemorySigner.fromKeyPair(nearjs.connection.networkId, account.accountId, newKeyPair);
        // sim error
        account.signAndSendTransactionWithAccountTemp = account.signAndSendTransactionWithAccount;
        account.signAndSendTransactionWithAccount = async (...args) => {
            await account.signAndSendTransactionWithAccountTemp(...args);
            throw new Error(someError);
        };
        try {
            await getAccount2FA(account);
        } catch (e) {
            expect(e.message).toEqual(someError);
        }
    });
    
});

