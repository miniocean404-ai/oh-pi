
/**
 * SSH Hosts Capability
 * SSH 主机能力
 *
 * Canonical shape for SSH host entries, regardless of source format.
 * SSH 主机条目的标准结构，与来源格式无关。
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical SSH host entry.
 * 标准 SSH 主机条目。
 */
export interface SSHHost {
	/** Host name (config key) */
	/** 主机名称（配置键） */
	name: string;
	/** Host address or DNS name */
	/** 主机地址或 DNS 名称 */
	host: string;
	/** Optional username override */
	/** 可选的用户名覆盖 */
	username?: string;
	/** Optional port override */
	/** 可选的端口覆盖 */
	port?: number;
	/** Optional identity key path */
	/** 可选的身份密钥路径 */
	keyPath?: string;
	/** Optional host description */
	/** 可选的主机描述 */
	description?: string;
	/** Optional compatibility mode flag */
	/** 可选的兼容模式标志 */
	compat?: boolean;
	/** Source metadata (added by loader) */
	/** 来源元数据（由加载器添加） */
	_source: SourceMeta;
}

/** SSH 主机能力定义 */
export const sshCapability = defineCapability<SSHHost>({
	id: "ssh",
	displayName: "SSH Hosts",
	description: "SSH host entries for remote command execution",
	key: host => host.name,
	validate: host => {
		if (!host.name) return "Missing name";
		if (!host.host) return "Missing host";
		return undefined;
	},
});

