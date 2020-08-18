import { NomicLabsBuidlerPluginError } from "@nomiclabs/buidler/plugins";
import SemverRange from "semver/classes/range";

import { pluginName } from "../pluginContext";

const COMPILERS_LIST_URL =
  "https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/bin/list.json";

// Non-exhaustive interface for the official compiler list.
export interface CompilersList {
  releases: {
    [version: string]: string;
  };
  latestRelease: string;
}

export class SolcVersionNumber {
  constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number
  ) {}

  public async getLongVersion(): Promise<string> {
    const shortVersion = `${this.major}.${this.minor}.${this.patch}`;
    const versions = await getVersions();
    const fullVersion = versions.releases[shortVersion];

    if (fullVersion === undefined || fullVersion === "") {
      throw new NomicLabsBuidlerPluginError(
        pluginName,
        "Given solc version doesn't exist"
      );
    }

    return fullVersion.replace(/(soljson-)(.*)(.js)/, "$2");
  }

  public toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}

export enum InferralType {
  EXACT,
  METADATA_PRESENT_VERSION_ABSENT,
  METADATA_ABSENT,
}

interface SolcVersionRange {
  inferralType: InferralType;
  /**
   * @returns true if the version is included in the range.
   */
  isIncluded(version: SolcVersionNumber): boolean;
  toString(): string;
}

export function getVersionNumber(shortVersion: string): SolcVersionNumber {
  const [major, minor, patch] = shortVersion
    .split(".", 3)
    .map((value) => parseInt(value, 10));
  return new SolcVersionNumber(major, minor, patch);
}

export async function inferSolcVersion(
  bytecode: Buffer
): Promise<SolcVersionRange> {
  const {
    readSolcVersion,
    VersionNotFoundError,
    MetadataAbsentError,
  } = await import("./metadata");

  let solcVersionMetadata: SolcVersionNumber;
  try {
    solcVersionMetadata = await readSolcVersion(bytecode);
  } catch (error) {
    // We want to provide our best inference here.
    // We can infer that some solidity compiler releases couldn't have produced this bytecode.
    // Solc v0.4.7 was the first compiler to introduce metadata into the generated bytecode.
    // See https://solidity.readthedocs.io/en/v0.4.7/miscellaneous.html#contract-metadata
    // Solc v0.4.26, the last release for the v0.4 series, does not feature the compiler version in its emitted metadata.
    // See https://solidity.readthedocs.io/en/v0.4.26/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
    // Solc v0.5.9 was the first compiler to introduce its version into the metadata.
    // See https://solidity.readthedocs.io/en/v0.5.9/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
    // Solc v0.6.0 features compiler version metadata.
    // See https://solidity.readthedocs.io/en/v0.6.0/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
    if (error instanceof VersionNotFoundError) {
      // The embedded metadata was successfully decoded but there was no solc version in it.
      const range = {
        isIncluded(version: SolcVersionNumber): boolean {
          return this.range.test(version.toString());
        },
        range: new SemverRange("0.4.7 - 0.5.8"),
        inferralType: InferralType.METADATA_PRESENT_VERSION_ABSENT,
        toString() {
          return this.range.toString();
        },
      };
      return range as SolcVersionRange;
    }
    if (error instanceof MetadataAbsentError) {
      // The decoding failed. Unfortunately, our only option is to assume that this bytecode was emitted by an old version.
      const range = {
        isIncluded(version: SolcVersionNumber): boolean {
          return this.range.test(version.toString());
        },
        range: new SemverRange("<0.4.7"),
        inferralType: InferralType.METADATA_ABSENT,
        toString() {
          return this.range.toString();
        },
      };
      return range as SolcVersionRange;
    }
    // Should be unreachable.
    throw error;
  }

  return {
    isIncluded: (version: SolcVersionNumber): boolean => {
      return (
        version.major === solcVersionMetadata.major &&
        version.minor === solcVersionMetadata.minor &&
        version.patch === solcVersionMetadata.patch
      );
    },
    inferralType: InferralType.EXACT,
    toString: () => {
      return `${solcVersionMetadata.major}.${solcVersionMetadata.minor}.${solcVersionMetadata.patch}`;
    },
  };
}

export async function getVersions(): Promise<CompilersList> {
  try {
    const { default: fetch } = await import("node-fetch");
    // It would be better to query an etherscan API to get this list but there's no such API yet.
    const compilersURL = new URL(COMPILERS_LIST_URL);
    const response = await fetch(compilersURL);

    if (!response.ok) {
      const responseText = await response.text();
      throw new NomicLabsBuidlerPluginError(
        pluginName,
        `HTTP response is not ok. Status code: ${response.status} Response text: ${responseText}`
      );
    }

    return response.json();
  } catch (error) {
    throw new NomicLabsBuidlerPluginError(
      pluginName,
      `Failed to obtain list of solc versions. Reason: ${error.message}`,
      error
    );
  }
}