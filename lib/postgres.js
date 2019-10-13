const { Pool } = require('pg'),
    utils = require('./utils'),
    winston = require('winston');


class Postgres {
    constructor(url) {
        this.pool = new Pool({
            connectionString: url
        });
    }

    connect() {
        return this.pool.connect().then(() => this.ensureSchema());
    }

    /*
        Returns the following properties in a 32 bit integer
                      rarity     quality    origin
        0000000000   00000000   00000000   00000000
        <future>      8 bits     8 bits     8 bits
     */
    static storeProperties(origin, quality, rarity) {
        return origin | (quality << 8) | (rarity << 16);
    }

    static extractProperties(prop) {
        return {
            origin: prop & ((1 << 8) - 1),
            quality: (prop >> 8) & ((1 << 8) - 1),
            rarity: (prop >> 16) & ((1 << 8) - 1)
        }
    }

    async ensureSchema() {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS items (
            ms          bigint  NOT NULL,
            a           bigint  NOT NULL,
            d           bigint  NOT NULL,
            paintseed   smallint NOT NULL,
            paintwear   integer NOT NULL,
            defindex    smallint NOT NULL,
            paintindex  smallint NOT NULL,
            stattrak    boolean NOT NULL,
            souvenir    boolean NOT NULL,
            props       integer NOT NULL,
            stickers    jsonb,
            updated     timestamp NOT NULL,
            rarity      smallint NOT NULL,
            PRIMARY KEY (a)
        )`);

        await this.pool.query(`CREATE INDEX IF NOT EXISTS i_stickers ON items USING gin (stickers jsonb_path_ops) 
                                WHERE stickers IS NOT NULL`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS i_paintwear ON items (paintwear)`);
        await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS i_unique_item ON 
                                items (defindex, paintindex, paintwear, paintseed)`);
    }

    async insertItemData(item) {
        item = Object.assign({}, item);

        // Store float as int32 to prevent float rounding errors
        // Postgres doesn't support unsigned types, so we use signed here
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(item.floatvalue, 0);
        item.paintwear = buf.readInt32BE(0);

        if (item.floatvalue <= 0) {
            // Only insert weapons, naive check
            return;
        }

        // Postgres doesn't support unsigned 64 bit ints, so we convert them to signed
        item.s = utils.unsigned64ToSigned(item.s).toString();
        item.a = utils.unsigned64ToSigned(item.a).toString();
        item.d = utils.unsigned64ToSigned(item.d).toString();
        item.m = utils.unsigned64ToSigned(item.m).toString();

        const stickers = item.stickers.length > 0 ? item.stickers.map((s) => {
            const res = {s: s.slot, i: s.stickerId};
            if (s.wear) {
                res.w = s.wear;
            }
            return res;
        }) : null;

        if (stickers) {
            // Add a property on stickers with duplicates that signifies how many dupes there are
            // Only add this property to one of the dupe stickers in the array
            for (const sticker of stickers) {
                const matching = stickers.filter((s) => s.i === sticker.i);
                if (matching.length > 1 && !matching.find((s) => s.d > 1)) {
                    sticker.d = matching.length;
                }
            }
        }

        try {
            const sm = item.s !== '0' ? item.s : item.m;
            const isStattrak = item.killeatervalue !== null;
            const isSouvenir = item.quality === 12;

            const props = Postgres.storeProperties(item.origin, item.quality, item.rarity);

            // We define unique items as those that have the same skin, wear, and paint seed
            // Duped items will be represented as one item in this case
            // If the item already exists, update it's link properties and stickers only if it is more recent
            // (higher item id)
            await this.pool.query(`INSERT INTO items VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now(), $12)
             ON CONFLICT (defindex, paintindex, paintwear, paintseed) DO UPDATE SET ms=$13, a=$14, d=$15, stickers=$16, updated=now() WHERE items.a < excluded.a`,
                [sm, item.a, item.d, item.paintseed, item.paintwear, item.defindex, item.paintindex, isStattrak,
                    isSouvenir, props, JSON.stringify(stickers), item.rarity, sm, item.a, item.d, JSON.stringify(stickers)]);
        } catch (e) {
            winston.warn(e);
        }
    }

    getItemData(params) {
        // Shallow copy
        params = Object.assign({}, params);
        params.a = utils.unsigned64ToSigned(params.a).toString();

        return this.pool.query(`SELECT *, 
                                       (SELECT Count(*)+1 
                                        FROM   (SELECT * 
                                                FROM   items T 
                                                WHERE  T.paintwear < S.paintwear 
                                                       AND T.defindex = S.defindex 
                                                       AND T.paintindex = S.paintindex 
                                                       AND T.stattrak = S.stattrak 
                                                       AND T.souvenir = S.souvenir 
                                                ORDER  BY T.paintwear 
                                                LIMIT  1000) as a) AS low_rank,
                                        (SELECT Count(*)+1
                                        FROM   (SELECT * 
                                                FROM   items J 
                                                WHERE  J.paintwear > S.paintwear 
                                                       AND J.defindex = S.defindex 
                                                       AND J.paintindex = S.paintindex 
                                                       AND J.stattrak = S.stattrak 
                                                       AND J.souvenir = S.souvenir 
                                                ORDER  BY J.paintwear DESC
                                                LIMIT  1000) as b) AS high_rank 
                                FROM   items S
                                WHERE  a=$1`,
            [params.a]).then((res) => {
            if (res.rows.length > 0) {
                let item = res.rows[0];
                delete item.updated;

                // Correspond to existing API, ensure we can still recreate the full item name
                if (item.stattrak) {
                    item.killeatervalue = 0;
                } else {
                    item.killeatervalue = null;
                }

                item.stickers = item.stickers || [];
                item.stickers = item.stickers.map((s) => {
                    return {
                        stickerId: s.i,
                        slot: s.s,
                        wear: s.w,
                    }
                });

                item = Object.assign(Postgres.extractProperties(item.props), item);

                const buf = Buffer.alloc(4);
                buf.writeInt32BE(item.paintwear, 0);
                item.floatvalue = buf.readFloatBE(0);

                item.a = utils.signed64ToUnsigned(item.a).toString();
                item.d = utils.signed64ToUnsigned(item.d).toString();
                item.ms = utils.signed64ToUnsigned(item.ms).toString();

                if (utils.isSteamId64(item.ms)){
                    item.s = item.ms;
                    item.m = '0';
                } else {
                    item.m = item.ms;
                    item.s = '0';
                }

                item.high_rank = parseInt(item.high_rank);
                item.low_rank = parseInt(item.low_rank);

                // Delete the rank if above 1000 (we don't get ranking above that)
                if (item.high_rank === 1001) {
                    delete item.high_rank;
                }

                if (item.low_rank === 1001) {
                    delete item.low_rank;
                }

                delete item.souvenir;
                delete item.stattrak;
                delete item.paintwear;
                delete item.ms;
                delete item.props;

                return item;
            }
        }).catch((err) => {
            winston.warn(err);
        });
    }

    getItemRank(id) {
        return this.pool.query(`SELECT (SELECT Count(*)+1
                                        FROM   (SELECT * 
                                                FROM   items T 
                                                WHERE  T.paintwear < S.paintwear 
                                                       AND T.defindex = S.defindex 
                                                       AND T.paintindex = S.paintindex 
                                                       AND T.stattrak = S.stattrak 
                                                       AND T.souvenir = S.souvenir 
                                                ORDER  BY T.paintwear 
                                                LIMIT  1000) as a) AS low_rank,
                                        (SELECT Count(*)+1 
                                        FROM   (SELECT * 
                                                FROM   items J 
                                                WHERE  J.paintwear > S.paintwear 
                                                       AND J.defindex = S.defindex 
                                                       AND J.paintindex = S.paintindex 
                                                       AND J.stattrak = S.stattrak 
                                                       AND J.souvenir = S.souvenir 
                                                ORDER  BY J.paintwear DESC
                                                LIMIT  1000) as b) AS high_rank 
                                FROM   items S
                                WHERE  a=$1`,
            [id]).then((res) => {
                if (res.rows.length > 0) {
                    const item = res.rows[0];
                    const result = {};

                    if (item.high_rank != 1001) {
                        result.high_rank = parseInt(item.high_rank);
                    }
                    if (item.low_rank != 1001) {
                        result.low_rank = parseInt(item.low_rank);
                    }

                    return result;
                } else {
                    return {};
                }
            });
    }
}

module.exports = Postgres;