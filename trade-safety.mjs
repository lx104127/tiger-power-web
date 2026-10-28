// Failed simulations and unapproved address risks never execute. App approval
// can only permit medium-risk findings in routes explicitly configured for it.
export function assertSafePreview(preview, { allowApp = false } = {}) {
  if (!preview?.success || !preview.data) throw new Error("交易预览失败");
  const data = preview.data;
  if (data.simulationResult?.simulationCode && data.simulationResult.simulationCode !== "000000000") throw new Error(`模拟失败:${data.simulationResult.simulationCode}`);
  const risks = [...(data.risks?.riskDetails || []), ...Object.values(data.risks?.addresses || {}).flatMap(value => value?.riskDetails || [])];
  if (data.requireConfirmation && !allowApp) throw new Error("交易需要 App 确认,按当前设置不提交");
  if (risks.length && !(allowApp && data.requireConfirmation && risks.every(risk => /^medium_/.test(String(risk?.code || ""))))) throw new Error("交易包含未获允许的风险,不执行");
  return risks;
}
