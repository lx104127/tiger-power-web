import { isAddress, ZeroAddress } from "ethers";

export async function assertNftEligibility({ wallet, readGate, readBalance }) {
  const nft = await readGate();
  if (!isAddress(nft)) throw new Error("NFT 门槛地址无法验证,不提交交易");
  if (nft.toLowerCase() === ZeroAddress) return { nft, count: null };
  const count = BigInt(await readBalance(nft, wallet));
  if (count <= 0n) throw new Error(`钱包 ${wallet} 没有门槛要求的 NFT(${nft}),跳过这个钱包,没有发交易`);
  return { nft, count };
}
