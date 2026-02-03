import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

/**
 * Example test file showing how to test Durable Objects with vitest-pool-workers.
 *
 * Key patterns:
 * - Import `env` from "cloudflare:test" to get DO bindings
 * - Use `env.BINDING_NAME.idFromName()` and `env.BINDING_NAME.get()` to get stubs
 * - Call RPC methods directly on the stub
 * - Each test gets isolated storage automatically
 *
 * KNOWN LIMITATION: Tests that expect DO methods to throw exceptions may cause
 * "Failed to pop isolated storage stack frame" errors with vitest-pool-workers.
 * Avoid testing exception scenarios directly; instead test the error handling
 * in your route actions where you call the DO methods.
 */

describe("ExampleDO", () => {
	// Get a fresh DO stub for each test
	function getStub() {
		const id = env.EXAMPLE_DO.idFromName("test");
		return env.EXAMPLE_DO.get(id);
	}

	describe("listContacts", () => {
		it("returns empty array when no contacts exist", async () => {
			const stub = getStub();
			const contacts = await stub.listContacts();

			expect(contacts).toEqual([]);
		});
	});

	describe("createContact", () => {
		it("creates a contact and returns it with id", async () => {
			const stub = getStub();

			const contact = await stub.createContact({
				name: "John Doe",
				email: "john@example.com",
			});

			expect(contact).toMatchObject({
				name: "John Doe",
				email: "john@example.com",
			});
			expect(contact.id).toBeDefined();
			expect(typeof contact.id).toBe("number");
		});

		it("creates multiple contacts with unique ids", async () => {
			const stub = getStub();

			const contact1 = await stub.createContact({
				name: "Alice",
				email: "alice@example.com",
			});
			const contact2 = await stub.createContact({
				name: "Bob",
				email: "bob@example.com",
			});

			expect(contact1.id).not.toBe(contact2.id);
		});
	});

	describe("deleteContact", () => {
		it("removes the contact from the database", async () => {
			const stub = getStub();

			// Create a contact
			const contact = await stub.createContact({
				name: "Jane Doe",
				email: "jane@example.com",
			});

			// Delete it
			await stub.deleteContact(contact.id);

			// Verify it's gone
			const contacts = await stub.listContacts();
			expect(contacts).toEqual([]);
		});
	});

	describe("_testExecSql helper", () => {
		it("allows raw SQL queries for test setup", async () => {
			const stub = getStub();

			// Insert test data directly
			stub._testExecSql(
				"INSERT INTO contacts (name, email) VALUES (?, ?)",
				"Test User",
				"test@example.com"
			);

			// Verify via RPC method
			const contacts = await stub.listContacts();
			expect(contacts).toHaveLength(1);
			expect(contacts[0].name).toBe("Test User");
		});
	});
});
