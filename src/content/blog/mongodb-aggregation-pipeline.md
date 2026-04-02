---
title: "MongoDB Aggregation Pipeline: Replace Your Application Logic with Database Logic"
date: "2025-11-05"
excerpt: "Stop fetching all documents and filtering in JavaScript. MongoDB's aggregation pipeline can do joins, grouping, pagination, and analytics in a single query."
tags:
  - mongodb
  - database
  - performance
---

# MongoDB Aggregation Pipeline: Replace Your Application Logic with Database Logic

I inherited a codebase that fetched every order from MongoDB, looped through them in Node.js to calculate daily revenue, grouped them by product category, and computed averages. For 10,000 orders this took 3 seconds. At 500,000 orders it took 45 seconds and crashed with an out-of-memory error.

I replaced 200 lines of JavaScript with a 30-line aggregation pipeline. Query time dropped to 180ms. This is not an exceptional story. I see this pattern constantly.

## The Core Concept

An aggregation pipeline is a sequence of stages. Documents enter stage one, get transformed, and flow into stage two. Think of it as Unix pipes for your database: `$match | $group | $sort | $limit`.

```javascript
const result = await Order.aggregate([
  { $match: { status: 'completed' } },
  { $group: {
    _id: '$category',
    totalRevenue: { $sum: '$amount' },
    orderCount: { $sum: 1 },
    avgOrderValue: { $avg: '$amount' },
  }},
  { $sort: { totalRevenue: -1 } },
]);
```

That replaces a `find()` + `filter()` + `reduce()` + `sort()` chain in your application code, and it runs on the database server where the data already lives.

## $match: Filter Early, Filter Often

Put `$match` as early as possible. It reduces the number of documents flowing through subsequent stages, and when placed first, it can use indexes.

```javascript
// Bad: $group runs on ALL orders, then we filter
const bad = await Order.aggregate([
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
  { $match: { total: { $gt: 1000 } } },
]);

// Good: $match first uses the index, fewer docs to group
const good = await Order.aggregate([
  { $match: { createdAt: { $gte: startOfMonth }, status: 'completed' } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
  { $match: { total: { $gt: 1000 } } },
]);
```

You can have multiple `$match` stages. The first one uses indexes. Later ones filter grouped results.

## $lookup: Joins in MongoDB

"MongoDB can't do joins" was true in 2013. `$lookup` is a left outer join.

```javascript
// Get orders with full customer info
const ordersWithCustomers = await Order.aggregate([
  { $match: { createdAt: { $gte: lastWeek } } },
  { $lookup: {
    from: 'customers',         // The collection to join
    localField: 'customerId',  // Field in orders
    foreignField: '_id',       // Field in customers
    as: 'customer',            // Output array field
  }},
  { $unwind: '$customer' },    // Convert single-element array to object
]);
```

`$lookup` always produces an array (because it is a left outer join). If you know there is exactly one match, `$unwind` flattens it to an object. If there is no match, `$unwind` removes the document entirely unless you use `preserveNullAndEmptyArrays`:

```javascript
{ $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } }
```

### Pipeline Lookup (The Powerful Version)

The basic `$lookup` only does equality matches. The pipeline version can do anything:

```javascript
const customersWithRecentOrders = await Customer.aggregate([
  { $lookup: {
    from: 'orders',
    let: { customerId: '$_id' },
    pipeline: [
      { $match: {
        $expr: {
          $and: [
            { $eq: ['$customerId', '$$customerId'] },
            { $gte: ['$createdAt', lastMonth] },
          ]
        }
      }},
      { $sort: { createdAt: -1 } },
      { $limit: 5 },
    ],
    as: 'recentOrders',
  }},
]);
```

This gets each customer's 5 most recent orders from the last month. Try doing that efficiently with multiple `find()` calls.

## $facet: Pagination + Count in One Query

The most common API pattern: return a page of results plus the total count. Without `$facet`, you need two queries:

```javascript
// Two queries - wasteful
const data = await Order.find(filter).skip(20).limit(10);
const total = await Order.countDocuments(filter);
```

With `$facet`, one query:

```javascript
const [result] = await Order.aggregate([
  { $match: filter },
  { $facet: {
    data: [
      { $sort: { createdAt: -1 } },
      { $skip: 20 },
      { $limit: 10 },
      { $project: { _id: 1, amount: 1, status: 1, createdAt: 1 } },
    ],
    meta: [
      { $count: 'total' },
    ],
  }},
  { $project: {
    data: 1,
    total: { $arrayElemAt: ['$meta.total', 0] },
  }},
]);

// result = { data: [...10 orders], total: 1547 }
```

`$facet` runs multiple sub-pipelines on the same input documents. Each sub-pipeline gets its own branch. This is one round trip instead of two.

## Real Analytics Query: Daily Revenue Report

Here is a production query I wrote for an analytics dashboard:

```javascript
async function getDailyRevenue(startDate, endDate) {
  return Order.aggregate([
    { $match: {
      status: 'completed',
      createdAt: { $gte: startDate, $lte: endDate },
    }},
    { $group: {
      _id: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        category: '$category',
      },
      revenue: { $sum: '$amount' },
      orders: { $sum: 1 },
      uniqueCustomers: { $addToSet: '$customerId' },
    }},
    { $addFields: {
      uniqueCustomerCount: { $size: '$uniqueCustomers' },
    }},
    { $group: {
      _id: '$_id.date',
      categories: {
        $push: {
          name: '$_id.category',
          revenue: '$revenue',
          orders: '$orders',
          uniqueCustomers: '$uniqueCustomerCount',
        },
      },
      totalRevenue: { $sum: '$revenue' },
      totalOrders: { $sum: '$orders' },
    }},
    { $sort: { _id: 1 } },
    { $project: {
      _id: 0,
      date: '$_id',
      totalRevenue: 1,
      totalOrders: 1,
      categories: 1,
    }},
  ]);
}
```

This produces a daily breakdown with per-category stats, unique customer counts, and totals. The equivalent JavaScript code was the 200-line monster I mentioned at the beginning.

## $bucket and $bucketAuto: Distribution Analysis

Need to know how your order values are distributed? `$bucket` creates histogram buckets:

```javascript
const distribution = await Order.aggregate([
  { $match: { status: 'completed' } },
  { $bucket: {
    groupBy: '$amount',
    boundaries: [0, 10, 50, 100, 500, 1000, Infinity],
    default: 'Other',
    output: {
      count: { $sum: 1 },
      avgAmount: { $avg: '$amount' },
    },
  }},
]);

// Result:
// [
//   { _id: 0, count: 234, avgAmount: 5.67 },     // $0-$10
//   { _id: 10, count: 1023, avgAmount: 28.90 },   // $10-$50
//   { _id: 50, count: 876, avgAmount: 72.15 },     // $50-$100
//   ...
// ]
```

## Pipeline Optimization Tips

### Use explain() to understand performance

```javascript
const explanation = await Order.aggregate(pipeline).explain('executionStats');
console.log(JSON.stringify(explanation, null, 2));
```

Look for `COLLSCAN` (collection scan). If you see it, your `$match` stage is not using an index.

### Create indexes for your aggregation pipelines

```javascript
// If you frequently aggregate by status + date
await Order.collection.createIndex({ status: 1, createdAt: -1 });
```

The `$match` stage can only use an index if it is the first stage (or immediately follows another `$match`). Any `$project`, `$group`, or `$unwind` between the start of the pipeline and your `$match` prevents index usage.

### Use $project to reduce document size

If your documents are large but you only need three fields, add a `$project` early:

```javascript
{ $project: { amount: 1, category: 1, createdAt: 1 } }
```

This reduces the memory footprint of each document flowing through the pipeline. For large collections, this is the difference between the pipeline running in memory and spilling to disk.

### The 100MB Memory Limit

By default, each pipeline stage can use at most 100MB of RAM. If you exceed this, the query fails. Two options:

```javascript
// Option 1: Allow disk use (slower but handles large datasets)
Order.aggregate(pipeline).option({ allowDiskUse: true });

// Option 2: Redesign your pipeline to use less memory
// Often, adding a $match or $project earlier fixes this
```

## When NOT to Use Aggregation

Aggregation pipelines are not always the answer:

**Simple CRUD operations.** If you are doing `find()` with a filter and a limit, do not wrap it in an aggregation pipeline. `find()` is simpler and slightly faster.

**Real-time queries on huge datasets.** If your pipeline takes more than a few seconds, consider pre-computing results with a materialized view or a cron job that writes to a summary collection.

**When you need transactions.** Aggregation pipelines are read-only (unless you end with `$merge` or `$out`). If you need to read and write atomically, use a transaction with regular operations.

The aggregation pipeline is the most underused feature of MongoDB. It eliminates entire categories of application code and moves the computation to where the data lives. Every time I see a `find().toArray()` followed by a loop, I check if a pipeline could do it better. Nine times out of ten, it can.
