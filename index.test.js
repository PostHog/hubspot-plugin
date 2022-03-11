const { resetMeta } = require('@posthog/plugin-scaffold/test/utils')
const { fetchAllCompanies, fetchAllDeals } = require('./index')

test('test skip fetching companies if company groupType not set', async () => {
    const companies = await fetchAllCompanies({}, resetMeta())
    expect(companies).toEqual([])
})

test('test skip fetching deals if deal groupType not set', async () => {
    const deals = await fetchAllDeals({}, resetMeta())
    expect(deals).toEqual([])
})
