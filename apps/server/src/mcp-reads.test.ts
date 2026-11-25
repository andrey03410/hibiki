import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "./app";
import { testContext } from "./test-utils";

let session: Awaited<ReturnType<typeof testContext>>;
let app: Awaited<ReturnType<typeof createApp>>;
let client: Client;
beforeEach(async () => {
  session = await testContext();
  app = await createApp({db:session.db, storageRoot:session.root});
  const url = await app.listen({host:"127.0.0.1", port:0});
  const {token} = await app.auth.createToken(session.userId, "read-test");
  client = new Client({name:"read-test",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp",url),{requestInit:{headers:{authorization:"Bearer "+token}}}));
  const when = new Date("2026-01-01T00:00:00Z");
  await session.db.item.createMany({data:["a","b","c","d","foreign"].map((id,index) => ({
    id, ownerId:id === "foreign" ? session.otherUserId : session.userId, title:"Трек "+index, originalTitle:"Песня "+index,
    kind:"audio", duration:index === 2 ? null : index === 1 ? 0 : index, createdAt:when,
    favorite:id!=="d", note:"Записка",
  }))});
});
afterEach(async () => { await client.close(); await app.close(); await session.close(); });
async function result(name: string, args: Record<string,unknown>) {
  const value = await client.callTool({name,arguments:args});
  return JSON.parse((value.content as {text:string}[])[0]!.text);
}

it("pages public media across ties and null durations and rejects cursors outside the chosen scope", async () => {
  for (const [sort,expected] of [["added-desc","abcd"],["duration-asc","abdc"],["duration-desc","dabc"],["title-asc","abcd"]]) {
    const order: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await result("media_list",{sort, limit:1, cursor:cursor ?? undefined});
      order.push(...page.items.map((item:{id:string})=>item.id));
      cursor = page.nextCursor;
    } while (cursor && order.length < 6);
    expect(order.join("")).toBe(expected);
  }
  expect((await result("media_list",{cursor:"d",favoriteOnly:true})).error.code).toBe("cursor");
  expect((await result("media_list",{cursor:"foreign"})).error.code).toBe("cursor");
  expect((await result("media_list",{query:"Записка"})).items).toEqual([]);
  const query = {query:"трек 0",view:"summary"};
  expect((await result("media_list", query)).items).toEqual([{id:"a",title:"Трек 0",kind:"audio",duration:0}]);
  await session.db.item.update({where:{id:"a"},data:{title:"Переименовано"}});
  expect((await result("media_list", query)).items).toEqual([]);
  expect((await result("media_get",{itemId:"foreign"})).error.code).toBe("item_not_found");
});

it("reads playlist members by page without exposing history or a different owner's records", async () => {
  const def = {version:1 as const, rule:{type:"items" as const,ids:["b","a","c"]},sort:"source" as const};
  const playlist = await session.library.savePlaylist(session.userId,{title:"Избранное",definition:def});
  const page = await result("playlist_get",{playlistId:playlist.id,limit:2});
  expect(page).toMatchObject({total:3,nextOffset:2,items:[{id:"b"},{id:"a"}]});
  expect(page).not.toHaveProperty("resolved");
  expect(page.playlist).not.toHaveProperty("definition");
  expect((await result("playlist_get",{playlistId:playlist.id,offset:2,limit:2})).items).toMatchObject([{id:"c"}]);
  const full = await result("playlist_get",{playlistId:playlist.id});
  expect(full).toMatchObject({playlist:{definition:def},resolved:{total:3}});
  expect((await result("capabilities",{includeCatalog:false})).tags).toBeUndefined();
  expect((await result("capabilities",{})).playlists).toEqual([{id:playlist.id,title:"Избранное"}]);
  const other = await session.library.savePlaylist(session.otherUserId,{title:"Чужой",definition:{...def,rule:{type:"items",ids:["foreign"]}}});
  expect((await result("playlist_get",{playlistId:other.id,limit:1})).error.code).toBe("playlist_not_found");
});

it("validates references including nested rules without reading item details or shared sources", async () => {
  const saved = await session.library.savePlaylist(session.userId, {title:"Источник",definition:{
    version:1, sort:"source", rule:{type:"items",ids:["a"]},
  }});
  const snapshot = vi.spyOn(app.library, "snapshot");
  const validate = (rule:unknown) => result("playlist_validate",{definition:{version:1,sort:"source",rule}});
  expect(await validate({type:"playlist",id:saved.id})).toEqual({valid:true,issues:[]});
  expect((await validate({type:"items",ids:["foreign"]})).valid).toBe(false);
  expect(snapshot).not.toHaveBeenCalled();
});

it("keeps full batch metadata and tag order identical to a single read and excludes nested foreign tag links", async () => {
  const ids = Array.from({length:32}, (_,i) => "group-"+i);
  await session.db.item.createMany({data:ids.map(id => ({id,ownerId:session.userId,kind:"audio",title:id,originalTitle:id}))});
  await session.db.tag.createMany({data:["zzz","aaa","other"].map(id => ({
    id, name:id, color:"#abc", ownerId:id === "other" ? session.otherUserId : session.userId,
  }))});
  await session.db.itemTag.createMany({data:ids.flatMap(itemId => ["zzz","other","aaa"].map(tagId => ({itemId,tagId})))});
  const page = await result("media_list",{query:"group-",limit:32});
  expect(page.items).toHaveLength(32);
  const first = await result("media_get",{itemId:page.items[0].id});
  expect(page.items[0]).toEqual(first);
  expect(first.tags.map((tag:{id:string})=>tag.id).sort()).toEqual(["aaa","zzz"]);
});
