
/*
本脚本用于验证 Conflux PoS Reward Record 数据的正确性.

由于 PoS Reward Record 数据在存储时, 未对区块链分叉情况做正确处理, 导致不同节点的 PoS Reward Record 数据不一致.

因为奖励数据数据库里只存了一份，主链从A切到B再切回A的时候，数据库里存的是B的版本，切回A判断说执行过了，就没有再去重新执行更新奖励数据了

验证方法是: 针对每个 PoS Epoch reward Record 数据, 获取奖励发放前和发放后的账户余额, 计算出实际发放的奖励金额, 与 PoS Reward Record 里记录的奖励金额进行对比. 如果不一致, 则说明该 PoS Reward Record 数据有误.

此方式依赖 Fullstate 节点, 来获取账户在指定区块高度的余额.

一些基本信息:

1. pos 奖励的发放, 是在 PoS Epoch 切换时, 对应的 PoW Epoch 的所有交易执行完之后发放的
2. 获取 PoS Epoch reward 记录数据的方法为 pos_getRewardsByEpoch, 该方法不仅能获取 PoS Reward Record 数据, 还能获取奖励发放的 PoW Epoch hash 
    另外还有一个方法: cfx_getPoSRewardByEpoch
3. cfx_getBalance 方法指定 epoch 高度, 应该获取的是该 epoch 执行完之后的账户余额
4. 另外需要获取 pow 某 Epoch 中所有导致账户余额变化的记录
    a. 获取所有的 receipts: cfx_getEpochReceipts, 但是该方法无法获取到 internal transaction(合约交易) 导致的余额变化
    b. 可使用 trace_epoch 方法, 获取该 epoch 所有的 trace 记录, 通过分析 trace 记录, 可获取到 internal transaction 导致的余额变化
*/

const { Conflux, format } = require('js-conflux-sdk');
const fs = require('fs');

const url = "http://8.217.41.74:12537";
// const url = "http://101.201.82.52:12537";
// const url = "https://main.confluxrpc.com/7Bj9kUPxzRjfsWg7QScCCMJMJiqn36gvLsoYrbfvFYyKgXAUnAFfR1YevKUvRYfpVzUmcJ1WNwChLGbMxj6WsEwP1";

const conflux = new Conflux({
    networkId: 1029,
    timeout: 600000,
    url,
});

const invalidPosEpoch = 8751;
const startPosEpoch = 7; // 从第 7 个 pos epoch 开始有奖励发放

async function main() {
    const posStatus = await conflux.pos.getStatus();
    const latestPosEpoch = posStatus.epoch;
    
    for (let epoch = startPosEpoch; epoch <= latestPosEpoch; epoch++) {
        try {
            let reward = await conflux.pos.getRewardsByEpoch(epoch);
            if (reward.accountRewards.length === 0) {
                console.log(`epoch ${epoch} has no reward records, skip`);
                continue;
            }

            // powEpochHash
            let powEpoch = await conflux.cfx.getBlockByHash(reward.powEpochHash, false);
            let powEpochNumber = powEpoch.epochNumber;

            let {addTransfers, subTransfers} = await getEpochInternalTransfers(powEpochNumber);

            let recordValid = true;
            for(let rewardRecord of reward.accountRewards) {
                let powAddress = format.address(rewardRecord.powAddress);
                
                let balanceBefore = await conflux.cfx.getBalance(powAddress, powEpochNumber - 1);
                let balanceAfter = await conflux.cfx.getBalance(powAddress, powEpochNumber);

                let internalAdd = addTransfers[powAddress] || 0n;
                let internalSub = subTransfers[powAddress] || 0n;

                if (balanceBefore + internalAdd - internalSub + rewardRecord.reward !== balanceAfter) {
                    console.error(`epoch ${epoch} reward record for account ${rewardRecord.powAddress} is invalid! expected reward: ${rewardRecord.reward}, actual reward: ${balanceAfter - balanceBefore}`);
                    recordValid = false;
                }
            }

            if (recordValid) {
                console.log(`PoS epoch ${epoch} reward records are all valid ✅`);
            } else {
                let errMsg = `PoS epoch ${epoch} reward records are invalid ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌`;
                console.log(errMsg);
                fs.appendFileSync('invalid_pos_rewards.log', errMsg + '\n');
            }

        } catch (err) {
            console.error(`epoch ${epoch} checking failed: ${err}`);
        }
    }
}

/*
    trace.type: create, create_result, call, call_result, internal_transfer, set_auth, selfdestruct
    通过 trace 记录, 计算出该 epoch 内部转账导致的余额变化
    返回 addTransfers, subTransfers
*/
async function getEpochInternalTransfers(epochNumber) {
    const epochTraces = await conflux.trace.epoch(epochNumber);
    let traceStack = [];
    // console.log(`epoch ${epochNumber} has ${epochTraces.cfxTraces.length} traces`);

    let addTransfers = {};
    let subTransfers = {};
    for (let trace of epochTraces.cfxTraces) {
        if (trace.type === 'internal_transfer_action') {
            if (!trace.valid) {
                continue;
            }
            let value = BigInt(trace.action.value);
            if (value === 0n) {
                continue;
            }
            if (trace.action.toPocket === 'balance' && trace.action.toSpace === 'native') {
                addTransfers[trace.action.to] = (addTransfers[trace.action.to] || 0n) + value;
            }
            if (trace.action.fromPocket === 'balance' && trace.action.fromSpace === 'native') {
                subTransfers[trace.action.from] = (subTransfers[trace.action.from] || 0n) + value;
            }
            continue;
        }

        if (trace.type === 'call' || trace.type === 'create') {
            traceStack.push(trace);
            continue;
        }

        if (trace.type === 'call_result') {
            if (traceStack.length === 0) {
                throw new Error('trace stack underflow');
            }
            if (traceStack[traceStack.length - 1].type !== "call") {
                throw new Error('trace stack mismatch');
            }
            let lastTrace = traceStack.pop();

            // case to skip, because these traces are not affecting account balance
            if (!lastTrace.valid || lastTrace.action.callType === 'staticcall' || lastTrace.action.space !== 'native') {
                continue;
            }
            if (trace.action.outcome !== 'success') {
                continue;
            }

            let value = BigInt(lastTrace.action.value);
            if (value === 0n) {
                continue;
            }
            addTransfers[lastTrace.action.to] = (addTransfers[lastTrace.action.to] || 0n) + value;
            subTransfers[lastTrace.action.from] = (subTransfers[lastTrace.action.from] || 0n) + value;
            continue;
        }

        if (trace.type === 'create_result') {
            if (traceStack.length === 0) {
                throw new Error('trace stack underflow');
            }
            if (traceStack[traceStack.length - 1].type !== "create") {
                throw new Error('trace stack mismatch');
            }

            let lastTrace = traceStack.pop();

            // case to skip, because these traces are not affecting account balance
            if (!lastTrace.valid || lastTrace.action.space !== 'native') {
                continue;
            }
            if (trace.action.outcome !== 'success') {
                continue;
            }

            let value = BigInt(lastTrace.action.value);
            if (value === 0n) {
                continue;
            }
            subTransfers[lastTrace.action.from] = (subTransfers[lastTrace.action.from] || 0n) + value;
            continue;
        }

        // ignore set_auth, selfdestruct
    }

    return {
        addTransfers,
        subTransfers,
    };
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});


// 跳过 epoch 有 trace 数据的情况
async function main1() {
    const posStatus = await conflux.pos.getStatus();
    const latestPosEpoch = posStatus.epoch;
    
    for (let epoch = startPosEpoch; epoch <= latestPosEpoch; epoch++) {
        let reward = await conflux.pos.getRewardsByEpoch(epoch);
        if (reward.accountRewards.length === 0) {
            console.log(`epoch ${epoch} has no reward records, skip`);
            continue;
        }

        // powEpochHash
        let powEpoch = await conflux.cfx.getBlockByHash(reward.powEpochHash, false);
        let powEpochNumber = powEpoch.epochNumber;

        const epochTraces = await conflux.trace.epoch(powEpochNumber);

        if (epochTraces.cfxTraces.length > 0) {
            console.log(`epoch ${epoch} pow epoch ${powEpochNumber} has traces, skip`);
            continue;
        }

        let recordValid = true;
        for(let rewardRecord of reward.accountRewards) {
            let balanceBefore = await conflux.cfx.getBalance(rewardRecord.powAddress, powEpochNumber - 1);
            let balanceAfter = await conflux.cfx.getBalance(rewardRecord.powAddress, powEpochNumber);

            if (balanceAfter - balanceBefore !== rewardRecord.reward) {
                console.error(`epoch ${epoch} reward record for account ${rewardRecord.powAddress} is invalid! expected reward: ${rewardRecord.reward}, actual reward: ${balanceAfter - balanceBefore}`);
                recordValid = false;
            }
        }

        if (recordValid) {
            console.log(`epoch ${epoch} reward records are all valid ✅✅✅✅✅✅✅`);
        } else {
            console.log(`epoch ${epoch} reward records are invalid ❌❌❌❌❌❌❌`);
        }

        if (epoch >= invalidPosEpoch + 2)
            break;

    }
}