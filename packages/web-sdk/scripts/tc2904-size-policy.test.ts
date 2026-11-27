import { describe, expect, test } from "bun:test";
import ledger from "./replica-size-ledger.json";
import { approvedTc2904OwnerDirectProofRoot, rootCeilingFor, validateLedger, validateTc2904OwnerDirectProofRootTransition } from "./replica-size-policy";

describe("TC-2904 exact proof-parser allowance", () => {
  test("admits the exact residual above TC-2872 and selects its ceiling", () => {
    validateLedger(ledger);
    expect(ledger.tc2904OwnerDirectProofRoot).toEqual(approvedTc2904OwnerDirectProofRoot);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      const row = ledger.tc2904OwnerDirectProofRoot;
      expect(row.root.ceiling[format] - ledger.tc2872RenewalRoot.root.ceiling[format]).toBe(row.root.delta[format]);
      expect(rootCeilingFor({ ...ledger, tc2924NodeAliasesRoot: undefined, tc2934RequestedAccountRoot: undefined, tc2936RestoreCommitRoot: undefined, tc2931BootstrapScope: undefined, tc2923EncryptionTeeOriginRoot: undefined, tc2949PanelChunkRecoveryRoot: undefined, tc2970RegistryVerdictCacheRoot: undefined, tc2913OpenKeyContinuationRoot: undefined, tc2987RegistryAbsentReadsRoot: undefined, tc2937SharePlacementRoot: undefined, tc3030FirstPartyOriginsRoot: undefined, tc3076ChildExpiryRoot: undefined, tc3168V1DefaultNodeRoot: undefined, tc3172DelegateNotBeforeRoot: undefined, tc3194NativeShareLinksRoot: undefined, tc3243SdkOwnsBusyRetryRoot: undefined, tc3285SecretTypesRoot: undefined, tc3286ShareNoDelegationActionsRoot: undefined, tc2944VaultPathClassifierRoot: undefined, tc3448OnBehalfPromptRoot: undefined, tc2490OneApprovalRoot: undefined, tc3661ShareLinkHostRoot: undefined, tc3522LeaseAskRoot: undefined, tc3443GenericManifestRoot: undefined, tc3688AccountIndexGuardRoot: undefined, tc3443SessionRetireRoot: undefined, tc3443PortFolderRoot: undefined, tc3704OpenKeyPromptRoot: undefined, tc3731ManifestOwnerRoot: undefined, tc3443AppIdLineBreakRoot: undefined, tc3549KeptApprovalsRoot: undefined, tc3617HostedMcpLeaseRoot: undefined, tc3947ReplicaRevokeRoot: undefined, tc3801NamedKeysRoot: undefined, tc3969SecretKeyCoverageRoot: undefined, tc3823BotHistoryKeyRoot: undefined, tc3802SecretKeyCapRoot: undefined, tc3862ExplorerOriginRoot: undefined, tc3522InvocationRefusalRoot: undefined, tc3810ReaderRoot: undefined, tc3975NamedKeyWarningRoot: undefined, tc4082HostedOwnerRoot: undefined, tc3891OwnerRegistryRecordRoot: undefined, tc4222PermissionLineRoot: undefined, tc4322ReservedKeyRoot: undefined, tc4329ActivationCauseRoot: undefined, tc4344OpenKeyAccountSetupRoot: undefined }, format)).toMatchObject({ row: "tc2904OwnerDirectProofRoot", ceiling: row.root.ceiling[format] });
    }
  });
  test("refuses changed, removed, or unstacked allowances", () => {
    const row = ledger.tc2904OwnerDirectProofRoot;
    validateTc2904OwnerDirectProofRootTransition(undefined, row);
    const changed = structuredClone(row);
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2904OwnerDirectProofRootTransition(undefined, changed)).toThrow("TC-2904");
    expect(() => validateTc2904OwnerDirectProofRootTransition(row, undefined)).toThrow("TC-2904");
    expect(() => validateLedger({ ...ledger, tc2872RenewalRoot: undefined, tc2872RenewalKvWorker: undefined, tc2872RenewalReplicaWorker: undefined })).toThrow("TC-2904");
  });
});
